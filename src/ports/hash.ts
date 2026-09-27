// SPDX-License-Identifier: Apache-2.0
//
// Deterministic port selection. Pure - no IO, no state.

/** Inclusive bounds of the range dev servers are assigned from by default. */
export const PORT_MIN = 4300;
export const PORT_MAX = 4999;

const PORT_RANGE = PORT_MAX - PORT_MIN + 1;

// Polynomial rolling hash. Bitwise-free so the intermediate never wraps into a
// negative int32, which would make the modulo asymmetric across inputs.
const HASH_PRIME = 31;
const HASH_MOD = 1_000_000_007;

/**
 * The preferred port for a route, so the same checkout reclaims the same port
 * across restarts whenever it is free.
 *
 * Keyed on the whole ROUTE KEY, not the branch alone. The route key includes the
 * project label, so two projects both on `main` get different preferred ports and
 * each keeps its own across restarts. Hashing the branch alone made them collide
 * on the first candidate every time and fall through to probe-and-increment,
 * which then handed out whichever port happened to be free - a different one on
 * every boot.
 */
export function preferredPort(routeKey: string): number {
  let hash = 0;
  for (let i = 0; i < routeKey.length; i++) {
    hash = (hash * HASH_PRIME + routeKey.charCodeAt(i)) % HASH_MOD;
  }
  return PORT_MIN + (hash % PORT_RANGE);
}

/**
 * Next candidate when the preferred port is taken, wrapping inside the range so
 * probing always terminates.
 */
export function nextPortCandidate(
  port: number,
  min = PORT_MIN,
  max = PORT_MAX,
): number {
  const next = port + 1;
  return next > max ? min : next;
}
