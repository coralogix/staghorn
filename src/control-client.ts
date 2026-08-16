// The client half of the daemon's control protocol: probe, lease, shut down.
//
// Every call here targets an explicit port. Nothing in this package assumes :80 -
// the daemon publishes what it bound to daemon.json, and callers pass it in. That
// single discipline is what makes the alternate-port rung, the in-process mode,
// two developers on one machine, and CI on Linux all work without special cases.

import { get as httpGet, request as httpRequest } from 'node:http';

import { errorMessage } from './errors';
import { silentLogger, type Logger } from './log';
import {
  CONTROL_HEADER,
  LEASE_PATH,
  LEGACY_SHUTDOWN_HEADER,
  LEGACY_SHUTDOWN_PATH,
  LEGACY_STATUS_PATH,
  SHUTDOWN_PATH,
  STATUS_PATH,
  isLegacyProxy,
  isOurProxy,
  isProxyStatus,
  readLegacyStatus,
  type ProbeOutcome,
} from './protocol';

const PROBE_TIMEOUT_MS = 300;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const LEASE_CONNECT_TIMEOUT_MS = 2_000;

/** Loopback literal used for every control call. Never the wildcard. */
const CONTROL_HOST = '127.0.0.1';

export interface ControlClientOptions {
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Ask what is listening on a port.
 *
 * `foreign` and `absent` are meaningfully different: absent means the rung is free
 * to claim, foreign means something else owns it and this rung must be skipped
 * rather than fought over.
 */
export async function probeProxy(
  port: number,
  { timeoutMs = PROBE_TIMEOUT_MS }: ControlClientOptions = {},
): Promise<ProbeOutcome> {
  const modern = await fetchBody(port, STATUS_PATH, timeoutMs);
  // Nobody listening at all: no point asking a second question.
  if (modern.kind === 'absent') {
    return { kind: 'absent' };
  }
  if (modern.kind === 'body') {
    const outcome = classify(modern.body);
    if (outcome.kind !== 'foreign') {
      return outcome;
    }
  }

  // Something IS listening but did not answer our control path. Before writing it
  // off, ask on the PRE-PACKAGE path: a legacy daemon serves only its own prefix,
  // so this is the only way it is ever recognised rather than mistaken for nginx.
  const legacy = await fetchBody(port, LEGACY_STATUS_PATH, timeoutMs);
  if (legacy.kind === 'body') {
    const status = parseJson(legacy.body);
    const translated = status === null ? null : readLegacyStatus(status);
    if (translated) {
      // It never reported its own port; it is by definition the one just probed.
      return { kind: 'legacy', status: { ...translated, port } };
    }
  }
  return { kind: 'foreign' };
}

type BodyResult =
  | { kind: 'body'; body: string }
  | { kind: 'absent' }
  | { kind: 'unusable' };

function fetchBody(
  port: number,
  path: string,
  timeoutMs: number,
): Promise<BodyResult> {
  return new Promise((resolve) => {
    const req = httpGet(
      {
        host: CONTROL_HOST,
        port,
        path,
        // Bare loopback Host, because control endpoints are answered only on hosts
        // that carry no route.
        headers: { host: CONTROL_HOST },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ kind: 'body', body }));
        res.on('error', () => resolve({ kind: 'unusable' }));
      },
    );
    // ECONNREFUSED means nobody is home. Anything else on this port is occupied.
    req.on('error', () => resolve({ kind: 'absent' }));
    req.on('timeout', () => {
      req.destroy();
      // Occupied but unresponsive - still not ours to take.
      resolve({ kind: 'unusable' });
    });
  });
}

function classify(body: string): ProbeOutcome {
  const parsed = parseJson(body);
  if (parsed === null || !isProxyStatus(parsed)) {
    return { kind: 'foreign' };
  }
  if (isOurProxy(parsed)) {
    return { kind: 'ours', status: parsed };
  }
  if (isLegacyProxy(parsed)) {
    return { kind: 'legacy', status: parsed };
  }
  return { kind: 'foreign' };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Ask a daemon to stop. Sends both the current control header and the legacy one,
 * so a pre-package daemon left running on a developer's machine can still be
 * retired by the new CLI instead of having to be hunted down by pid.
 */
export async function requestShutdown(
  port: number,
  options: ControlClientOptions = {},
): Promise<boolean> {
  // The modern path first, then the pre-package one. A legacy daemon serves only its
  // own prefix, so without the second attempt `stop` silently does nothing to the
  // very daemon it was most likely run to get rid of.
  return (
    (await postShutdown(port, SHUTDOWN_PATH, options)) ||
    (await postShutdown(port, LEGACY_SHUTDOWN_PATH, options))
  );
}

function postShutdown(
  port: number,
  path: string,
  { timeoutMs = SHUTDOWN_TIMEOUT_MS, logger = silentLogger }: ControlClientOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: CONTROL_HOST,
        port,
        method: 'POST',
        path,
        headers: {
          host: CONTROL_HOST,
          [CONTROL_HEADER]: 'shutdown',
          [LEGACY_SHUTDOWN_HEADER]: '1',
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', (err) => {
      logger.debug('shutdown request failed', { error: errorMessage(err) });
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export interface ProxyLease {
  /** Release the lease. Idempotent. */
  release(): void;
  /** True once the daemon acknowledged the lease. */
  readonly held: boolean;
}

/**
 * Hold a lease for the lifetime of this process.
 *
 * The open socket IS the lease: the OS closes it however this process ends -
 * clean exit, Ctrl-C, crash, SIGKILL - so the daemon learns from a socket close
 * rather than from anything cooperative. Two details matter:
 *
 *   - the connect timeout is cleared once established, because a lease is idle by
 *     design and would otherwise be torn down by its own timeout;
 *   - the socket is unreffed, so holding a lease never keeps this process alive.
 */
export function holdLease(
  port: number,
  routeKey: string,
  { logger = silentLogger }: ControlClientOptions = {},
): Promise<ProxyLease> {
  return new Promise((resolve) => {
    let settled = false;
    let held = false;

    const req = httpGet(
      {
        host: CONTROL_HOST,
        port,
        path: `${LEASE_PATH}?route=${encodeURIComponent(routeKey)}`,
        headers: { host: CONTROL_HOST, [CONTROL_HEADER]: 'lease' },
        timeout: LEASE_CONNECT_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }
        // Established: drop the timeout, or an idle lease kills itself.
        req.setTimeout(0);
        res.socket?.unref();
        res.on('data', () => {
          // The daemon writes one line to confirm, then nothing.
          finish(true);
        });
        res.on('error', () => {
          held = false;
        });
        res.on('close', () => {
          held = false;
        });
      },
    );
    req.on('error', (err) => {
      logger.debug('could not hold a lease', { error: errorMessage(err) });
      finish(false);
    });
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.socket?.unref();

    function finish(acquired: boolean): void {
      held = acquired;
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        release: () => {
          held = false;
          req.destroy();
        },
        get held() {
          return held;
        },
      });
    }
  });
}
