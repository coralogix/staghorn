// SPDX-License-Identifier: Apache-2.0
//
// The host shape, and the routing that reverses it. Pure - no IO, no state.
//
//   [<prefix>.]{<service>.}<branch>.<project>.<tld>
//        ^          ^           ^        ^
//    wildcard,   optional,   slugged   grouping label
//    absorbed    part of     branch    (on by default)
//    by routing  the route
//
// The two labels in the middle - service and branch and project - form the ROUTE
// KEY: the dotted suffix a dev server registers. Everything to the left of it is
// an arbitrary prefix the app is free to use for its own purposes (tenant, team,
// locale) and is ignored for routing.

/** Browsers resolve `*.localhost` to loopback per RFC 6761, and treat it as a secure context. */
export const DEFAULT_TLD = 'localhost';

/** DNS label ceiling (RFC 1035). */
export const MAX_LABEL_LENGTH = 63;

/** Total hostname ceiling (RFC 1035), which the label budget has to respect too. */
export const MAX_HOSTNAME_LENGTH = 253;

/** The pieces a dev server registers, in host order (left to right). */
export interface RouteParts {
  /**
   * Distinguishes several dev servers in one checkout (app + storybook + api).
   * null for the default service, which keeps single-server hosts one label
   * shorter.
   */
  readonly service?: string | null;
  /** The slugged branch (or short sha on a detached HEAD). */
  readonly branch: string;
  /**
   * The grouping label. null flattens it away for consumers who genuinely have
   * one project per machine, but leaving it on is what makes URLs stable: every
   * project has a `main`, and without this label two of them collide and get
   * order-dependent `-2` suffixes that flip on the next boot.
   */
  readonly project?: string | null;
}

/**
 * The dotted suffix identifying one dev server, without the tld -
 * `feature-x.myapp`, or `storybook.feature-x.myapp`.
 *
 * Project is rightmost deliberately. It is the coarser, more stable grouping, so
 * putting it closest to the tld makes `*.myapp.<tld>` a single meaningful
 * wildcard: one /etc/hosts line per project, one dnsmasq entry, one mkcert SAN
 * set - instead of one per branch.
 */
export function buildRouteKey({
  service,
  branch,
  project,
}: RouteParts): string {
  return [service, branch, project].filter(isNonEmpty).join('.');
}

/** Split a route key back into its labels, left to right. */
export function routeKeyLabels(routeKey: string): string[] {
  return routeKey.split('.').filter(isNonEmpty);
}

/**
 * The authority to put in a URL: `[<prefix>.]<routeKey>.<tld>[:<port>]`.
 *
 * `port` is omitted when the proxy owns :80 (the portless case) and present on
 * every other rung of the fallback ladder. The HOSTNAME is identical either way,
 * which is the property that lets a bookmark survive a degrade.
 */
export function buildHost({
  routeKey,
  prefix,
  tld = DEFAULT_TLD,
  port,
}: {
  routeKey: string;
  prefix?: string | null;
  tld?: string;
  port?: number | null;
}): string {
  const hostname = [prefix, routeKey, tld].filter(isNonEmpty).join('.');
  return port === undefined || port === null
    ? hostname
    : `${hostname}:${port}`;
}

/**
 * Split a Host header into its hostname and port.
 *
 * Handles the bracketed IPv6 form. The original implementation did
 * `hostHeader.split(':')[0]`, which turns `[::1]:80` into the single character
 * `[` - harmless there only because such a host never carried a label, but wrong,
 * and wrong in a function whose whole job is trusting its output.
 */
export function splitHostHeader(
  hostHeader: string | undefined,
): { hostname: string; port: number | null } | null {
  const raw = hostHeader?.trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) {
      return null;
    }
    return {
      hostname: raw.slice(1, close).toLowerCase(),
      port: parsePort(raw.slice(close + 1)),
    };
  }
  const colon = raw.indexOf(':');
  if (colon === -1) {
    return { hostname: raw.toLowerCase(), port: null };
  }
  return {
    hostname: raw.slice(0, colon).toLowerCase(),
    port: parsePort(raw.slice(colon)),
  };
}

/**
 * The labels of a Host header that sit under `tld`, left to right, or null when
 * the host is not under the tld at all (bare `localhost`, an IP, someone else's
 * domain). The tld may itself be multi-label - `localtest.me` is a supported
 * value - so it is stripped as a suffix string, never as one label.
 */
export function labelsUnderTld(
  hostHeader: string | undefined,
  tld: string = DEFAULT_TLD,
): string[] | null {
  const split = splitHostHeader(hostHeader);
  if (!split) {
    return null;
  }
  const suffix = `.${tld.toLowerCase()}`;
  if (!split.hostname.endsWith(suffix)) {
    return null;
  }
  const labels = split.hostname.slice(0, -suffix.length).split('.');
  return labels.every(isNonEmpty) ? labels : null;
}

/** A resolved route: which registered key matched, and what prefix sat above it. */
export interface HostMatch {
  /** The registered route key that matched. */
  readonly routeKey: string;
  /** Labels to the left of the route key, left to right. Empty for an exact hit. */
  readonly prefix: string[];
}

/**
 * Resolve a Host header to a registered route by LONGEST SUFFIX MATCH.
 *
 * This replaces the original "the route key is the last label before the tld".
 * That rule cannot express a multi-label route at all, so it made the project
 * label impossible, forced services to smuggle themselves into the branch slug,
 * and silently mis-routed any consumer whose app used more than one prefix label.
 *
 * Longest-first is what gives the shape its precedence for free:
 *   team-a.storybook.feature-x.myapp  ->  storybook.feature-x.myapp  (service wins)
 *   team-a.feature-x.myapp            ->  feature-x.myapp           (prefix ignored)
 *   dev                               ->  dev                       (fixed-origin alias)
 *
 * `isRegistered` is passed in rather than a registry being imported, so this
 * stays pure and the daemon can back it with whatever it likes (a live snapshot,
 * a test fixture, an in-memory map).
 */
export function matchHost(
  hostHeader: string | undefined,
  isRegistered: (routeKey: string) => boolean,
  tld: string = DEFAULT_TLD,
): HostMatch | null {
  const labels = labelsUnderTld(hostHeader, tld);
  if (!labels || labels.length === 0) {
    return null;
  }
  // Longest suffix first: start with the whole host, then peel one prefix label
  // at a time. The first registered key wins.
  for (let start = 0; start < labels.length; start++) {
    const routeKey = labels.slice(start).join('.');
    if (isRegistered(routeKey)) {
      return { routeKey, prefix: labels.slice(0, start) };
    }
  }
  return null;
}

/**
 * True when the host is the bare tld or a loopback literal - i.e. carries no
 * route at all.
 *
 * The control API is served only on these hosts. The original design claimed
 * `/__cx_dev_domains__/*` on every host for every method, which shadowed those
 * paths in every consumer app and needed a special case to answer CORS
 * preflights ahead of the upstream. Restricting control traffic to the hosts that
 * have nothing to route removes both problems: no consumer path is ever taken.
 */
export function isControlHost(
  hostHeader: string | undefined,
  tld: string = DEFAULT_TLD,
): boolean {
  const split = splitHostHeader(hostHeader);
  if (!split) {
    // No Host header at all (HTTP/1.0). Nothing to route, so treat as control.
    return true;
  }
  const { hostname } = split;
  return (
    hostname === tld.toLowerCase() ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '::ffff:127.0.0.1'
  );
}

function parsePort(raw: string): number | null {
  const digits = raw.startsWith(':') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const port = Number.parseInt(digits, 10);
  return port > 0 && port <= 65_535 ? port : null;
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
