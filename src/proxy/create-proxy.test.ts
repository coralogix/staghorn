// Integration test for the daemon over REAL sockets, on an ephemeral port.
//
// This is the coverage the predecessor had none of. It is possible here for one
// reason: the listen address is configuration rather than the constant 80, so
// every case below runs unprivileged on Linux, macOS and Windows alike. Binding
// :80 is exercised in exactly one platform-gated test elsewhere - it is an
// assertion about the OS, not about this code.

import { mkdtempSync } from 'node:fs';
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeClock, type FakeClock } from '../clock';
import { createRecordingLogger } from '../log';
import { CONTROL_HEADER, LEASE_PATH, SHUTDOWN_PATH, STATUS_PATH } from '../protocol';
import { createDaemonInfoStore } from '../state/daemon-info';
import { createFileRouteStore, type RouteStore } from '../state/routes';
import { createProxy, type ProxyHandle } from './create-proxy';
import { LEASE_LINGER_MS } from './leases';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Reverse order: proxies before the upstreams they forward to.
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
});

describe('createProxy routing', () => {
  it('forwards a request to the dev server named by the Host header', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    const res = await fetchThroughProxy(proxy, '/', 'main.myapp.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello from upstream');
  });

  it('passes the Host header through unchanged', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    await fetchThroughProxy(proxy, '/', 'dashboard.main.myapp.localhost');
    expect(upstream.lastRequest()?.headers.host).toBe(
      'dashboard.main.myapp.localhost',
    );
  });

  it('ignores an arbitrary app prefix when routing', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    const res = await fetchThroughProxy(
      proxy,
      '/',
      'team-a.dashboard.main.myapp.localhost',
    );
    expect(res.status).toBe(200);
  });

  // The precedence the host shape depends on, end to end.
  it('prefers a longer registered suffix, so a service route wins', async () => {
    const { proxy, store, upstream } = await harness();
    const other = await startUpstream('storybook');
    await register(store, 'feature-x.myapp', upstream.port);
    await register(store, 'storybook.feature-x.myapp', other.port);

    const app = await fetchThroughProxy(proxy, '/', 'feature-x.myapp.localhost');
    const book = await fetchThroughProxy(
      proxy,
      '/',
      'storybook.feature-x.myapp.localhost',
    );
    expect(app.body).toBe('hello from upstream');
    expect(book.body).toBe('storybook');
  });

  it('keeps the same branch in two projects apart', async () => {
    const { proxy, store, upstream } = await harness();
    const other = await startUpstream('other project');
    await register(store, 'main.myapp', upstream.port);
    await register(store, 'main.other', other.port);

    expect((await fetchThroughProxy(proxy, '/', 'main.myapp.localhost')).body).toBe(
      'hello from upstream',
    );
    expect((await fetchThroughProxy(proxy, '/', 'main.other.localhost')).body).toBe(
      'other project',
    );
  });

  it('forwards the method, path and query', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    await fetchThroughProxy(proxy, '/api/thing?a=1&b=2', 'main.myapp.localhost', {
      method: 'DELETE',
    });
    expect(upstream.lastRequest()?.method).toBe('DELETE');
    expect(upstream.lastRequest()?.url).toBe('/api/thing?a=1&b=2');
  });

  it('adds x-forwarded-* so frameworks can build absolute URLs', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    await fetchThroughProxy(proxy, '/', 'main.myapp.localhost');
    const headers = upstream.lastRequest()?.headers ?? {};
    expect(headers['x-forwarded-host']).toBe('main.myapp.localhost');
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers['x-forwarded-for']).toBeTruthy();
  });

  it('does not forward hop-by-hop headers', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    await fetchThroughProxy(proxy, '/', 'main.myapp.localhost', {
      headers: { te: 'trailers', 'proxy-authorization': 'Basic zzz' },
    });
    const headers = upstream.lastRequest()?.headers ?? {};
    expect(headers['te']).toBeUndefined();
    expect(headers['proxy-authorization']).toBeUndefined();
  });

  it('preserves repeated response headers such as set-cookie', async () => {
    const { proxy, store } = await harness();
    const upstream = await startUpstream('ok', (_req, res) => {
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.writeHead(200);
      res.end('ok');
    });
    await register(store, 'main.myapp', upstream.port);

    const res = await fetchThroughProxy(proxy, '/', 'main.myapp.localhost');
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('streams a chunked response without buffering it', async () => {
    const { proxy, store } = await harness();
    const upstream = await startUpstream('', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first ');
      setTimeout(() => res.end('second'), 10);
    });
    await register(store, 'main.myapp', upstream.port);

    const res = await fetchThroughProxy(proxy, '/', 'main.myapp.localhost');
    expect(res.body).toBe('first second');
  });
});

describe('createProxy failure pages', () => {
  it('404s a host that carries no route', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, '/', 'nothing.myapp.localhost');
    expect(res.status).toBe(404);
    expect(res.body).toContain('No dev server is registered');
  });

  it('404s the bare tld with a different explanation', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, '/', 'localhost');
    expect(res.status).toBe(404);
    expect(res.body).toContain('Nothing is served on this host');
  });

  it('502s when the registered dev server is gone', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);
    await upstream.close();

    const res = await fetchThroughProxy(proxy, '/', 'main.myapp.localhost');
    expect(res.status).toBe(502);
    expect(res.body).toContain('not responding');
  });

  // Never a package manager, and never the origin repo's script names.
  it('shows the configured list command, not a hardcoded one', async () => {
    const { proxy } = await harness({ listCommand: 'just staghorn list' });
    const res = await fetchThroughProxy(proxy, '/', 'localhost');
    expect(res.body).toContain('just staghorn list');
    expect(res.body).not.toContain('pnpm run');
  });

  it('escapes a branch name in an error page', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'x.myapp', upstream.port, {
      branch: '<img src=x onerror=alert(1)>',
    });
    await upstream.close();

    const res = await fetchThroughProxy(proxy, '/', 'x.myapp.localhost');
    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('&lt;img');
  });
});

describe('createProxy control API', () => {
  it('answers status on the bare tld', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, STATUS_PATH, 'localhost');
    expect(res.status).toBe(200);

    const status: unknown = JSON.parse(res.body);
    expect(status).toMatchObject({ name: 'staghorn', protocol: 1 });
  });

  it('reports the port it actually bound', async () => {
    const { proxy } = await harness();
    expect(proxy.status().port).toBe(proxy.address.port);
  });

  // The property that keeps control paths out of every consumer app's URL space.
  it('does not claim control paths on a routed host', async () => {
    const { proxy, store, upstream } = await harness();
    await register(store, 'main.myapp', upstream.port);

    const res = await fetchThroughProxy(proxy, STATUS_PATH, 'main.myapp.localhost');
    expect(res.body).toBe('hello from upstream');
    expect(upstream.lastRequest()?.url).toBe(STATUS_PATH);
  });

  it('refuses shutdown without the control header', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, SHUTDOWN_PATH, 'localhost', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('refuses shutdown on the wrong method', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, SHUTDOWN_PATH, 'localhost', {
      headers: { [CONTROL_HEADER]: 'shutdown' },
    });
    expect(res.status).toBe(405);
  });

  it('shuts down when properly asked', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, SHUTDOWN_PATH, 'localhost', {
      method: 'POST',
      headers: { [CONTROL_HEADER]: 'shutdown' },
    });
    expect(res.status).toBe(200);
    await expect(proxy.closed).resolves.toBe('requested');
  });

  it('refuses a lease without the control header', async () => {
    const { proxy } = await harness();
    const res = await fetchThroughProxy(proxy, LEASE_PATH, 'localhost');
    expect(res.status).toBe(403);
  });
});

describe('createProxy lease lifetime', () => {
  it('exits a linger after the last lease closes', async () => {
    const { proxy, clock } = await harness();
    const lease = await openLease(proxy);
    expect(proxy.leases).toBe(1);

    await lease.close();
    await settle();
    clock.advance(LEASE_LINGER_MS);
    await expect(proxy.closed).resolves.toBe('idle');
  });

  it('stays up while a lease is held', async () => {
    const { proxy, clock } = await harness();
    await openLease(proxy);

    clock.advance(LEASE_LINGER_MS * 10);
    await settle();
    expect(await raceClosed(proxy)).toBe('still-open');
  });
});

describe('createProxy client trust', () => {
  // Layer 1: refused at accept time, before Node parses a request line or a
  // single header. The client sees a reset, not a status - which is the point.
  it('destroys the connection of an untrusted client', async () => {
    const { proxy } = await harness({ isTrustedClient: () => false });
    await expect(fetchThroughProxy(proxy, '/', 'localhost')).rejects.toThrow(
      /ECONNRESET|socket hang up/,
    );
  });

  // Layer 2 exists so that a gap in layer 1 is not a hole. Proving it needs a
  // predicate that admits the connection and then rejects the request; with one
  // static predicate layer 1 always wins and layer 2 would look like dead code.
  it('still refuses at request time if a connection slips through', async () => {
    let calls = 0;
    const { proxy } = await harness({
      isTrustedClient: () => {
        calls++;
        return calls === 1;
      },
    });
    const res = await fetchThroughProxy(proxy, '/', 'localhost');
    expect(res.status).toBe(403);
  });
});

describe('createProxy upgrades', () => {
  it('tunnels an upgrade to the dev server verbatim', async () => {
    const { proxy, store } = await harness();
    const upstream = await startRawUpstream();
    await register(store, 'main.myapp', upstream.port);

    const socket = connect(proxy.address.port, '127.0.0.1');
    cleanups.push(() => void socket.destroy());
    await once(socket, 'connect');
    socket.write(
      'GET /hmr HTTP/1.1\r\n' +
        'Host: main.myapp.localhost\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Cookie: a=1\r\n' +
        'Cookie: b=2\r\n' +
        '\r\n',
    );

    const head = await upstream.firstRequestHead();
    // Verbatim means the handshake headers survive AND the two Cookie headers
    // arrive as two headers - not joined with ', ', which is what the predecessor
    // did and which corrupts a cookie jar.
    expect(head).toContain('Upgrade: websocket');
    expect(head).toContain('Connection: Upgrade');
    expect(head).toContain('Cookie: a=1\r\nCookie: b=2');
    expect(head).not.toContain('a=1, b=2');
  });

  it('drops an upgrade for an unknown host', async () => {
    const { proxy } = await harness();
    const socket = connect(proxy.address.port, '127.0.0.1');
    cleanups.push(() => void socket.destroy());
    await once(socket, 'connect');
    socket.write(
      'GET / HTTP/1.1\r\nHost: nope.myapp.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    await once(socket, 'close');
    expect(socket.destroyed).toBe(true);
  });
});

describe('createProxy advertising', () => {
  it('publishes the bound address so clients never assume a port', async () => {
    const { proxy, dir } = await harness();
    const info = await createDaemonInfoStore({
      path: () => join(dir, 'daemon.json'),
    }).read();
    expect(info?.port).toBe(proxy.address.port);
    expect(info?.pid).toBe(process.pid);
  });

  it('clears the advertisement on shutdown', async () => {
    const { proxy, dir } = await harness();
    await proxy.close();

    const store = createDaemonInfoStore({ path: () => join(dir, 'daemon.json') });
    expect(await store.read()).toBeNull();
  });
});

describe('createProxy hot reload', () => {
  it('picks up a route registered after it started', async () => {
    const { proxy, store, upstream } = await harness();
    expect((await fetchThroughProxy(proxy, '/', 'late.myapp.localhost')).status).toBe(
      404,
    );

    await register(store, 'late.myapp', upstream.port);
    await settle(120);
    expect((await fetchThroughProxy(proxy, '/', 'late.myapp.localhost')).status).toBe(
      200,
    );
  });
});

// --- harness -------------------------------------------------------------

async function harness({
  listCommand,
  isTrustedClient,
}: {
  listCommand?: string;
  isTrustedClient?: (address: string | undefined) => boolean;
} = {}): Promise<{
  proxy: ProxyHandle;
  store: RouteStore;
  upstream: Upstream;
  clock: FakeClock;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'staghorn-proxy-'));
  const store = createFileRouteStore({
    dir: () => join(dir, 'routes'),
    watchDebounceMs: 10,
  });
  const clock = createFakeClock();
  const upstream = await startUpstream('hello from upstream');

  const proxy = await createProxy(
    {
      listen: { port: 0, host: '127.0.0.1' },
      refreshTtlMs: 0,
      ...(listCommand === undefined ? {} : { listCommand }),
    },
    {
      routes: store,
      daemonInfo: createDaemonInfoStore({ path: () => join(dir, 'daemon.json') }),
      // Real `now`, fake timers: the lease policy is asserted deterministically
      // while the snapshot TTL still behaves against wall-clock socket traffic.
      clock: { ...clock, now: () => Date.now() },
      logger: createRecordingLogger(),
      version: '9.9.9-test',
      ...(isTrustedClient ? { isTrustedClient } : {}),
    },
  );
  cleanups.push(() => proxy.close());
  return { proxy, store, upstream, clock, dir };
}

function register(
  store: RouteStore,
  routeKey: string,
  port: number,
  overrides: { branch?: string } = {},
): Promise<unknown> {
  const [service, branch, project] = splitKey(routeKey);
  return store.upsert({
    routeKey,
    port,
    pid: process.pid,
    checkoutPath: '/repo',
    branch: overrides.branch ?? branch,
    project,
    service,
  });
}

function splitKey(routeKey: string): [string | null, string, string | null] {
  const labels = routeKey.split('.');
  if (labels.length >= 3) {
    return [labels[0] ?? null, labels[1] ?? '', labels[2] ?? null];
  }
  if (labels.length === 2) {
    return [null, labels[0] ?? '', labels[1] ?? null];
  }
  return [null, labels[0] ?? '', null];
}

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface Upstream {
  readonly port: number;
  lastRequest(): SeenRequest | null;
  close(): Promise<void>;
}

async function startUpstream(
  body: string,
  handler?: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<Upstream> {
  let last: SeenRequest | null = null;
  const server = createServer((req, res) => {
    last = { method: req.method, url: req.url, headers: { ...req.headers } };
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  const port = await listenEphemeral(server);
  const upstream: Upstream = {
    port,
    lastRequest: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  cleanups.push(() => upstream.close());
  return upstream;
}

/** A raw TCP listener, so an upgrade's exact bytes can be asserted. */
async function startRawUpstream(): Promise<{
  port: number;
  firstRequestHead(): Promise<string>;
}> {
  let resolveHead: (head: string) => void = () => {};
  const head = new Promise<string>((resolve) => {
    resolveHead = resolve;
  });
  const { createServer: createNetServer } = await import('node:net');
  const server = createNetServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        resolveHead(buffer);
      }
    });
    socket.on('error', () => socket.destroy());
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port, firstRequestHead: () => head };
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

interface ProxyResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function fetchThroughProxy(
  proxy: ProxyHandle,
  path: string,
  host: string,
  {
    method = 'GET',
    headers = {},
  }: { method?: string; headers?: Record<string, string> } = {},
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxy.address.port,
        method,
        path,
        headers: { host, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function openLease(
  proxy: ProxyHandle,
): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      {
        host: '127.0.0.1',
        port: proxy.address.port,
        path: LEASE_PATH,
        headers: { host: 'localhost', [CONTROL_HEADER]: 'lease' },
      },
      (res) => {
        res.on('data', () => {
          resolve({
            close: () =>
              new Promise<void>((done) => {
                res.destroy();
                setTimeout(done, 20);
              }),
          });
        });
        res.on('error', () => {});
      },
    );
    req.on('error', reject);
  });
}

async function raceClosed(proxy: ProxyHandle): Promise<string> {
  return Promise.race([
    proxy.closed,
    new Promise<string>((resolve) => setTimeout(() => resolve('still-open'), 50)),
  ]);
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter: import('node:events').EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}
