// SPDX-License-Identifier: Apache-2.0
//
// The wire contract between the daemon and every client (the CLI, the serve
// seam, the lease holder, the tests). No IO - constants, shapes and guards only.

/** Identifies our daemon in the /status payload, versus a foreign server. */
export const PROXY_NAME = 'staghorn';

/**
 * Names an earlier, pre-package daemon answered with.
 *
 * A developer migrating a repo to this package may already have the old in-repo
 * daemon bound to the port. Without this allowlist the new client would classify
 * it `foreign`, silently fall back to ported URLs, and give no hint why. Accepted
 * as "ours, but old" for one minor so the staleness warning fires instead.
 */
export const LEGACY_PROXY_NAMES: readonly string[] = ['cx-dev-domains-proxy'];

/**
 * Bumped on any change to the /status shape, the lease protocol, or routing
 * behaviour.
 *
 * Independent of the npm version: a package patch may carry a protocol bump, and
 * a package major may not. Mismatched protocol majors cannot share a port, so the
 * newer client ladders down to its own port rather than fighting for the shared
 * one - which is why this must never move backwards.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Rung 1. On macOS (Mojave and later) an unprivileged process may bind a port
 * below 1024 only on the WILDCARD address - `127.0.0.1:80` is still root-only.
 * That is the whole reason this tool needs no sudo, and also why the daemon has
 * to enforce loopback-only clients itself.
 */
export const DEFAULT_WILDCARD_PORT = 80;

/**
 * Rung 2. No privileges required on any platform, so this is where Linux lands by
 * default and where everyone lands when something else owns :80. The hostname is
 * unchanged - only the port appears - so a bookmark survives the degrade.
 */
export const DEFAULT_SHARED_PORT = 4180;

/**
 * A dev server told to listen on `localhost` may bind ::1 or 127.0.0.1 depending
 * on the machine's resolution order, so anything reaching one (routing, liveness
 * probes) has to try both families.
 */
export const UPSTREAM_HOSTS: readonly string[] = ['127.0.0.1', '::1'];

/**
 * Control endpoints live under this prefix AND are served only on hosts that
 * carry no route (see `isControlHost`).
 *
 * The earlier design claimed its control prefix on every host for every method,
 * which shadowed those paths in every consumer app and needed a bespoke branch to
 * answer CORS preflights ahead of the upstream. Scoping by host instead means no
 * consumer path is ever taken, and the preflight question disappears with it.
 */
export const CONTROL_PREFIX = '/__staghorn__';

export const STATUS_PATH = `${CONTROL_PREFIX}/status`;
export const LEASE_PATH = `${CONTROL_PREFIX}/lease`;
export const SHUTDOWN_PATH = `${CONTROL_PREFIX}/shutdown`;

/**
 * Every mutating control request must carry this header.
 *
 * A browser cannot attach a custom header to a cross-site request without a CORS
 * preflight, which the daemon never approves - so a random web page the developer
 * has open cannot shut the daemon down, nor open leases that keep it alive after
 * every dev server is gone. Local tooling can do both. One header with a value,
 * rather than one header per endpoint, so the check is a single code path.
 */
export const CONTROL_HEADER = 'x-staghorn-control';

/** Sent alongside {@link CONTROL_HEADER} so `stop` can retire a legacy daemon. */
export const LEGACY_SHUTDOWN_HEADER = 'x-cx-dev-domains-shutdown';

/**
 * Control paths of the pre-package daemon.
 *
 * Needed, not nostalgia. A legacy daemon answers only its OWN control prefix, so
 * probing the modern path gets a 404 and the daemon is classified `foreign` - which
 * makes the legacy-name allowlist unreachable, hides the "restart it" hint, and
 * leaves `stop` unable to retire it. Probing both paths is the only way the
 * migration story actually works, as opposed to merely being written down.
 */
export const LEGACY_CONTROL_PREFIX = '/__cx_dev_domains__';
export const LEGACY_STATUS_PATH = `${LEGACY_CONTROL_PREFIX}/status`;
export const LEGACY_SHUTDOWN_PATH = `${LEGACY_CONTROL_PREFIX}/shutdown`;

/**
 * Shape guard for a legacy /status payload, and its translation into the modern
 * shape.
 *
 * Separate from {@link isProxyStatus} because the legacy daemon has no `protocol`
 * field at all - it carried one `version` number - so the modern guard rejects it.
 * Returns null rather than a boolean so the translation happens once, here.
 */
export function readLegacyStatus(value: unknown): ProxyStatus | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if (
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !LEGACY_PROXY_NAMES.includes(value.name) ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('pid' in value) ||
    typeof value.pid !== 'number'
  ) {
    return null;
  }
  return {
    name: value.name,
    // Its single `version` was the wire version, so it maps onto `protocol`. It is
    // necessarily an incompatible major, which is what triggers the restart hint.
    protocol: value.version,
    version: `legacy-${value.version}`,
    pid: value.pid,
    routes: 'routes' in value && typeof value.routes === 'number' ? value.routes : 0,
    leases: 0,
    port: 0,
    // The legacy daemon never reported an owner, and unknown must not be read as
    // "mine" - see isCurrentUid.
    uid: null,
    stateDir: '',
  };
}

export type ControlAction = 'status' | 'lease' | 'shutdown';

/** Wire shape of `GET /status`. */
export interface ProxyStatus {
  readonly name: string;
  /** {@link PROTOCOL_VERSION} of the running daemon. */
  readonly protocol: number;
  /** npm version of the package the daemon was spawned from. */
  readonly version: string;
  readonly pid: number;
  /** Number of live routes the daemon can currently serve. */
  readonly routes: number;
  /** Open leases. Zero means the daemon is inside its linger window. */
  readonly leases: number;
  /** Address the daemon actually bound. */
  readonly port: number;
  /**
   * OS user that owns the daemon. A daemon owned by someone else is never
   * leased and never shut down - two developers on one machine each get their
   * own, rather than one silently killing the other's.
   */
  readonly uid: number | null;
  /** Where the owning daemon keeps its routes, for diagnosing split state. */
  readonly stateDir: string;
}

/** How a probe of the control port turned out. */
export type ProbeOutcome =
  | { readonly kind: 'ours'; readonly status: ProxyStatus }
  | { readonly kind: 'legacy'; readonly status: ProxyStatus }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'absent' };

/**
 * Shape guard for the /status payload. Whatever answers the control port is
 * untrusted until it proves otherwise, so every field is checked rather than
 * asserted.
 */
export function isProxyStatus(value: unknown): value is ProxyStatus {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'name' in value &&
    typeof value.name === 'string' &&
    'protocol' in value &&
    typeof value.protocol === 'number' &&
    'pid' in value &&
    typeof value.pid === 'number'
  );
}

/** True when a /status payload came from this implementation. */
export function isOurProxy(status: ProxyStatus): boolean {
  return status.name === PROXY_NAME;
}

/** True when it came from a pre-package daemon we still recognise. */
export function isLegacyProxy(status: ProxyStatus): boolean {
  return LEGACY_PROXY_NAMES.includes(status.name);
}

/**
 * True when two protocol majors can share one daemon. Same major only: routing
 * semantics may differ across majors, and a client that assumed otherwise would
 * mis-route rather than fail.
 */
export function isProtocolCompatible(remote: number): boolean {
  return remote === PROTOCOL_VERSION;
}

/**
 * The daemon binds the wildcard address - the only way to get :80 unprivileged on
 * macOS - so it must refuse every non-loopback client itself, before routing.
 * Enforced at three layers (connection, request, upgrade) because any one of them
 * alone leaves a gap.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    // IPv4-mapped IPv6 form of any 127.x address.
    /^::ffff:127\./.test(address)
  );
}

/** Headers a proxy must not forward verbatim (RFC 9110 hop-by-hop). */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
