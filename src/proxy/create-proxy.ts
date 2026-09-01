// SPDX-License-Identifier: Apache-2.0
//
// The daemon, as a factory.
//
// One instance per machine serves a single port and routes each request to the
// dev server named by its Host header, using the route registry as the routing
// table.
//
// Why no sudo is needed: macOS (Mojave+) permits an unprivileged bind below 1024
// ONLY on the wildcard address - binding 127.0.0.1:80 is still root-only. So the
// wildcard gets bound and loopback-only clients are enforced here instead, at
// three layers: accept time, request time, and upgrade time. Any one of them
// alone leaves a gap.
//
// Everything is injected and nothing runs at import time. The predecessor ran
// `main()` on import and kept its routing table in module-level `let`s, which is
// precisely why it, its spawn path, its launcher and all three of its CLIs had no
// tests at all. Here the entry point (daemon.ts) is a shim and this file is
// ordinary testable code.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  createServer as nodeCreateServer,
  request as nodeHttpRequest,
} from 'node:http';
import { connect as nodeConnect, type Socket } from 'node:net';

import { systemClock, type Clock } from '../clock';
import { errorCode, errorMessage } from '../errors';
import { DEFAULT_TLD, isControlHost, matchHost } from '../host';
import { silentLogger, type Logger } from '../log';
import { stateDir } from '../paths';
import {
  CONTROL_HEADER,
  DEFAULT_SHARED_PORT,
  LEASE_PATH,
  LEGACY_SHUTDOWN_HEADER,
  PROTOCOL_VERSION,
  PROXY_NAME,
  SHUTDOWN_PATH,
  STATUS_PATH,
  UPSTREAM_HOSTS,
  isLoopbackAddress,
  type ProxyStatus,
} from '../protocol';
import {
  createDaemonInfoStore,
  type DaemonInfoStore,
} from '../state/daemon-info';
import {
  createFileRouteStore,
  type DevRoute,
  type RouteSnapshot,
  type RouteStore,
} from '../state/routes';
import {
  forwardRequestHeaders,
  forwardResponseHeaders,
  upgradeRequestHead,
} from './headers';
import { createLeaseTracker, type LeaseTracker } from './leases';
import { renderErrorPage, type ErrorPageRenderer } from './pages';

/** Everything the daemon touches that is not pure computation. */
export interface ProxyDeps {
  readonly routes?: RouteStore;
  readonly daemonInfo?: DaemonInfoStore;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Which client addresses may be served. Defaults to loopback only. */
  readonly isTrustedClient?: (address: string | undefined) => boolean;
  readonly createServer?: typeof nodeCreateServer;
  readonly httpRequest?: typeof nodeHttpRequest;
  readonly connect?: typeof nodeConnect;
  /** npm version, surfaced in /status so library-vs-daemon skew is visible. */
  readonly version?: string;
}

export interface ProxyOptions {
  /**
   * Address to bind. `port: 0` takes an ephemeral one, which is what every test
   * uses - no privileges, no collisions, and no reason to ever bind :80 in CI.
   * `host: null` means the wildcard, required for the unprivileged :80 trick.
   */
  readonly listen?: { readonly port?: number; readonly host?: string | null };
  readonly tld?: string;
  readonly lease?: {
    readonly lingerMs?: number;
    readonly bootGraceMs?: number;
    readonly maxLeases?: number;
  };
  readonly upstreamHosts?: readonly string[];
  /** Add x-forwarded-* to forwarded requests. */
  readonly forwardedHeaders?: boolean;
  readonly errorPage?: ErrorPageRenderer;
  /** Command shown on error pages. Never hardcodes a package manager. */
  readonly listCommand?: string;
  /** How long a routing-table snapshot may be reused between reads. */
  readonly refreshTtlMs?: number;
  /** Skip writing daemon.json - the in-process mode is nobody else's business. */
  readonly advertise?: boolean;
}

export type ProxyCloseReason = 'idle' | 'requested' | 'manual';

export interface ProxyHandle {
  /** The address actually bound, which is a runtime fact, never an assumption. */
  readonly address: { readonly host: string | null; readonly port: number };
  status(): ProxyStatus;
  readonly leases: number;
  /**
   * Resolves when the daemon stops, with the reason.
   *
   * The daemon never calls process.exit itself: that would make the in-process
   * mode impossible and the whole thing untestable. The entry shim awaits this
   * and exits; an embedded consumer just awaits it.
   */
  readonly closed: Promise<ProxyCloseReason>;
  close(): Promise<void>;
}

const DEFAULT_REFRESH_TTL_MS = 500;

export async function createProxy(
  options: ProxyOptions = {},
  deps: ProxyDeps = {},
): Promise<ProxyHandle> {
  const {
    listen = {},
    tld = DEFAULT_TLD,
    lease = {},
    upstreamHosts = UPSTREAM_HOSTS,
    forwardedHeaders = true,
    errorPage = renderErrorPage,
    listCommand = 'npx staghorn list',
    refreshTtlMs = DEFAULT_REFRESH_TTL_MS,
    advertise = true,
  } = options;
  const {
    routes = createFileRouteStore(),
    daemonInfo = createDaemonInfoStore(),
    clock = systemClock,
    logger = silentLogger,
    isTrustedClient = isLoopbackAddress,
    createServer = nodeCreateServer,
    httpRequest = nodeHttpRequest,
    connect = nodeConnect,
    version = '0.0.0',
  } = deps;

  const port = listen.port ?? DEFAULT_SHARED_PORT;
  const host = listen.host ?? null;

  // --- routing table: a snapshot, refreshed on change and on staleness ---

  let snapshot: RouteSnapshot = routes.readSync();
  let readAt = clock.now();

  const currentRoutes = (): RouteSnapshot => {
    if (clock.now() - readAt < refreshTtlMs) {
      return snapshot;
    }
    readAt = clock.now();
    try {
      snapshot = routes.readSync();
    } catch (err) {
      // A read failure must not leave the daemon reporting itself healthy while
      // it 404s everything with nothing in its log to explain why.
      logger.warn('routing table read failed; serving the previous snapshot', {
        error: errorMessage(err),
      });
    }
    return snapshot;
  };

  const refresh = (): void => {
    try {
      snapshot = routes.readSync();
      readAt = clock.now();
      logger.debug('routing table reloaded', { routes: snapshot.size });
    } catch (err) {
      logger.warn('routing table reload failed', { error: errorMessage(err) });
    }
  };

  const lookup = (hostHeader: string | undefined): DevRoute | undefined => {
    const table = currentRoutes();
    const match = matchHost(hostHeader, (key) => table.has(key), tld);
    return match ? table.get(match.routeKey) : undefined;
  };

  // --- lifetime ---

  let resolveClosed: (reason: ProxyCloseReason) => void = () => {};
  const closed = new Promise<ProxyCloseReason>((resolve) => {
    resolveClosed = resolve;
  });
  let closing = false;

  const leases: LeaseTracker = createLeaseTracker({
    onIdle: () => {
      logger.info('no dev servers left - stopping', { pid: process.pid });
      void shutdown('idle');
    },
    timers: clock,
    ...(lease.lingerMs === undefined ? {} : { lingerMs: lease.lingerMs }),
    ...(lease.bootGraceMs === undefined ? {} : { bootGraceMs: lease.bootGraceMs }),
    ...(lease.maxLeases === undefined ? {} : { maxLeases: lease.maxLeases }),
  });

  const server: Server = createServer();

  // --- request handling ---

  const sendPage = (
    res: ServerResponse,
    status: 404 | 502,
    info: Omit<Parameters<ErrorPageRenderer>[0], 'status' | 'listCommand'>,
  ): void => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(errorPage({ ...info, status, listCommand }));
  };

  const handleStatus = (res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(statusPayload()));
  };

  const handleLease = (req: IncomingMessage, res: ServerResponse): void => {
    // Loopback alone cannot gate this: the developer's BROWSER is a loopback
    // client, so a web page could otherwise open leases and keep the daemon alive
    // forever - inverting the property leases exist to provide. A custom header
    // makes it a preflighted request, and the preflight is never approved.
    if (req.headers[CONTROL_HEADER] !== 'lease') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!leases.hold(res)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many staghorn leases\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    // One line so the client knows the lease is established, then nothing: the
    // response is deliberately never ended - its open socket IS the lease.
    res.write('leased\n');
  };

  const handleShutdown = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    const control = req.headers[CONTROL_HEADER];
    const legacy = req.headers[LEGACY_SHUTDOWN_HEADER];
    if (control !== 'shutdown' && legacy !== '1') {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('shutting down\n');
    // Let the response flush before tearing the listener down.
    setImmediate(() => void shutdown('requested'));
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isTrustedClient(req.socket.remoteAddress)) {
      res.writeHead(403);
      res.end();
      return;
    }

    // Control endpoints are answered ONLY on hosts that carry no route, and by
    // exact pathname. Host-scoping is what keeps these paths out of every
    // consumer app's URL space - the predecessor claimed them on every host for
    // every method, which shadowed them everywhere and forced a bespoke branch to
    // beat the upstream to the CORS preflight. Exact, not prefix: the lease client
    // appends `?label=`, and prefix matching would hand a lease to anything merely
    // starting with the path.
    if (isControlHost(req.headers.host, tld)) {
      const pathname = req.url?.split('?')[0];
      if (pathname === STATUS_PATH) {
        handleStatus(res);
        return;
      }
      if (pathname === LEASE_PATH) {
        handleLease(req, res);
        return;
      }
      if (pathname === SHUTDOWN_PATH) {
        handleShutdown(req, res);
        return;
      }
      sendPage(res, 404, { kind: 'no-route-on-host' });
      return;
    }

    const route = lookup(req.headers.host);
    if (!route) {
      sendPage(res, 404, { kind: 'route-not-registered' });
      return;
    }
    forward(req, res, route, 0);
  };

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    route: DevRoute,
    hostIndex: number,
  ): void => {
    const upstreamHost = upstreamHosts[hostIndex];
    if (upstreamHost === undefined) {
      sendPage(res, 502, {
        kind: 'upstream-down',
        branch: route.branch,
        port: route.port,
      });
      return;
    }
    const proxyReq = httpRequest(
      {
        host: upstreamHost,
        port: route.port,
        method: req.method,
        path: req.url,
        headers: forwardRequestHeaders(req.rawHeaders, {
          remoteAddress: req.socket.remoteAddress,
          forwarded: forwardedHeaders,
        }),
      },
      (proxyRes) => {
        proxyRes.on('error', () => res.destroy());
        res.writeHead(
          proxyRes.statusCode ?? 502,
          forwardResponseHeaders(proxyRes.rawHeaders),
        );
        // Nothing buffers, which is what makes SSE and chunked streaming work
        // through the proxy without any special case.
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      // The upstream died mid-response: its headers are already on the wire, so
      // writeHead would throw ERR_HTTP_HEADERS_SENT inside an error handler and
      // take the shared daemon down with it. Nothing can be salvaged.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // A dev server told to listen on `localhost` may have bound only the other
      // loopback family - retry once before declaring it dead. Only while the body
      // is untouched: the pipe below drains `req` into the socket that just
      // failed, so retrying after any data was read would replay a truncated body.
      // Bodyless requests - the GETs and handshakes this proxy mostly carries -
      // always retry.
      if (
        errorCode(err) === 'ECONNREFUSED' &&
        hostIndex + 1 < upstreamHosts.length &&
        !req.readableDidRead
      ) {
        forward(req, res, route, hostIndex + 1);
        return;
      }
      logger.debug('upstream unreachable', {
        routeKey: route.routeKey,
        port: route.port,
        error: errorMessage(err),
      });
      sendPage(res, 502, {
        kind: 'upstream-down',
        branch: route.branch,
        port: route.port,
      });
    });
    // Client aborts - tab close, reload, cancelled preloads - are routine; an
    // unhandled 'error' on either stream would crash the shared daemon.
    req.on('error', () => proxyReq.destroy());
    res.on('error', () => proxyReq.destroy());
    req.pipe(proxyReq);
  };

  // --- connection upgrade (HMR websockets, and any other tunnel) ---

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    hostIndex = 0,
  ): void => {
    if (!isTrustedClient(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const route = lookup(req.headers.host);
    if (!route) {
      socket.destroy();
      return;
    }
    const upstreamHost = upstreamHosts[hostIndex];
    if (upstreamHost === undefined) {
      socket.destroy();
      return;
    }
    const upstream = connect(route.port, upstreamHost, () => {
      // Verbatim rawHeaders - an upgrade is a tunnel, and the transport on the
      // far side may be anything (Vite's ws, webpack's sockjs, a framework's own).
      upstream.write(upgradeRequestHead(req));
      if (head?.length) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', (err) => {
      if (
        errorCode(err) === 'ECONNREFUSED' &&
        hostIndex + 1 < upstreamHosts.length
      ) {
        handleUpgrade(req, socket, head, hostIndex + 1);
        return;
      }
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  };

  // --- teardown ---

  let stopWatching: () => void = () => {};

  const shutdown = async (reason: ProxyCloseReason): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    stopWatching();
    leases.stop();
    // End held leases before dropping the socket, so dev servers see a clean
    // close rather than a reset.
    leases.closeAll();
    if (advertise) {
      await daemonInfo.clear().catch((err: unknown) => {
        logger.debug('could not clear daemon info', { error: errorMessage(err) });
      });
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Idle keep-alive sockets would otherwise hold close() open; the daemon has
      // no reason to wait for them.
      server.closeIdleConnections?.();
    });
    resolveClosed(reason);
  };

  const statusPayload = (): ProxyStatus => ({
    name: PROXY_NAME,
    protocol: PROTOCOL_VERSION,
    version,
    pid: process.pid,
    routes: currentRoutes().size,
    leases: leases.size,
    port: boundPort,
    uid: processUid(),
    // Always reported, even when not advertised: a client diagnosing "the daemon
    // is up but my route is missing" needs to know which state dir it is reading.
    stateDir: stateDir(),
  });

  // --- bind ---

  server.on('request', handleRequest);
  server.on('upgrade', handleUpgrade);
  // The wildcard bind is the price of unprivileged :80, so the port is reachable
  // from every network the machine joins. Refuse untrusted peers at accept time,
  // before Node parses a request line or a single header. The per-request and
  // per-upgrade checks stay on as layers two and three.
  server.on('connection', (socket) => {
    if (!isTrustedClient(socket.remoteAddress)) {
      socket.destroy();
    }
  });

  const boundAddress = await listenOn(server, port, host);
  const boundPort = boundAddress.port;
  if (advertise) {
    await daemonInfo.write({
      name: PROXY_NAME,
      protocol: PROTOCOL_VERSION,
      version,
      pid: process.pid,
      port: boundPort,
      host,
    });
  }

  leases.start();
  // Route changes are picked up immediately by watching, and self-heal on
  // staleness for the SIGKILL case, where a dead dev server writes nothing at all.
  stopWatching = routes.watch(refresh);

  logger.info('listening', {
    port: boundPort,
    host: host ?? '*',
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
  });

  return {
    address: { host, port: boundPort },
    status: statusPayload,
    get leases() {
      return leases.size;
    },
    closed,
    close: () => shutdown('manual'),
  };
}

/**
 * Bind, turning the callback pair into a promise and surfacing the bind error as
 * a rejection.
 *
 * EACCES (an unprivileged wildcard :80 on stock Linux) and EADDRINUSE (something
 * else owns the port) are the two that matter, and both must be reported rather
 * than exited on - the caller ladders down to the next rung.
 */
function listenOn(
  server: Server,
  port: number,
  host: string | null,
): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound to a non-inet address'));
        return;
      }
      resolve({ port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // No host argument means a dual-stack wildcard bind - the unprivileged-:80
    // path on macOS.
    if (host === null) {
      server.listen(port);
    } else {
      server.listen(port, host);
    }
  });
}

function processUid(): number | null {
  // Windows has no uid, and process.getuid is absent there entirely.
  const uid = process.getuid?.();
  return typeof uid === 'number' ? uid : null;
}
