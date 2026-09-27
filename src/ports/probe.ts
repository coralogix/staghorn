// SPDX-License-Identifier: Apache-2.0
//
// Finding a port a dev server can actually bind.
//
// Only needed by the `allocate` strategy. The default strategy is `discover` - let
// the dev server bind whatever it likes and learn the real port afterwards - which
// is what makes the CLI wrapper work with no configuration and no {{port}}
// plumbing in the consumer's command.

import { createServer } from 'node:net';

import { UPSTREAM_HOSTS } from '../protocol';
import { PORT_MAX, PORT_MIN, nextPortCandidate, preferredPort } from './hash';

/**
 * Whether a port is free on ALL the given loopback families.
 *
 * Both families, because a dev server told to listen on `localhost` resolves it
 * per the machine's DNS order: it may land on ::1 on one laptop and 127.0.0.1 on
 * the next. A port free on one and taken on the other is not usable, and finding
 * that out at bind time means the dev server fails to start.
 */
export async function isPortFree(
  port: number,
  hosts: readonly string[] = UPSTREAM_HOSTS,
): Promise<boolean> {
  const results = await Promise.all(hosts.map((host) => isPortFreeOn(port, host)));
  return results.every(Boolean);
}

function isPortFreeOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (free: boolean): void => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    server.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRNOTAVAIL / EAFNOSUPPORT mean the family itself is unavailable on this
      // machine (an IPv4-only or IPv6-only host). That is not a busy port, so it
      // must not count as one - otherwise every port looks taken and allocation
      // spins through the whole range.
      if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
        resolve(true);
        return;
      }
      resolve(false);
    });
    server.once('listening', () => done(true));
    server.listen(port, host);
  });
}

export interface PickPortOptions {
  /** Deterministic first candidate. Defaults to a hash of the route key. */
  readonly preferred?: number;
  readonly min?: number;
  readonly max?: number;
  readonly hosts?: readonly string[];
  /** Ports another dev server has claimed this instant but may not have bound yet. */
  readonly claimed?: ReadonlySet<number>;
  readonly isFree?: (port: number) => Promise<boolean>;
}

/**
 * A free port for a route, preferring the deterministic candidate so the same
 * checkout reclaims the same port across restarts.
 *
 * Returns null when the range is exhausted rather than throwing - the caller has a
 * working fallback (let the dev server pick) and should not be handed an exception
 * for a resource question.
 */
export async function pickPort(
  routeKey: string,
  {
    preferred,
    min = PORT_MIN,
    max = PORT_MAX,
    hosts = UPSTREAM_HOSTS,
    claimed = new Set<number>(),
    isFree = (port) => isPortFree(port, hosts),
  }: PickPortOptions = {},
): Promise<number | null> {
  const first = clamp(preferred ?? preferredPort(routeKey), min, max);
  let candidate = first;
  // The range is finite and nextPortCandidate wraps, so this terminates after at
  // most one full lap.
  for (let step = 0; step <= max - min; step++) {
    if (!claimed.has(candidate) && (await isFree(candidate))) {
      return candidate;
    }
    candidate = nextPortCandidate(candidate, min, max);
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min || value > max) {
    // Keep the mapping deterministic rather than snapping to an edge, so an
    // out-of-range preference still spreads across the range.
    return min + (Math.abs(value - min) % (max - min + 1));
  }
  return value;
}
