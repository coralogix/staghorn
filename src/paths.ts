// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-user state directory, shared by every checkout on the machine and
 * deliberately outside all of them - the route registry has to outlive
 * `git worktree remove`.
 *
 * Resolved through a function rather than a module-level constant on purpose.
 * The original version read the env var once at import time, which forced every
 * test that wanted an isolated state dir to call `vi.resetModules()` in a
 * `beforeEach` and made those suites impossible to parallelise. Reading it per
 * call costs nothing and the whole class of ordering bugs disappears.
 *
 * Precedence: STAGHORN_STATE_DIR -> $XDG_STATE_HOME/dev-domains -> ~/.dev-domains
 */
export function stateDir(): string {
  const explicit = process.env['STAGHORN_STATE_DIR']?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = process.env['XDG_STATE_HOME']?.trim();
  if (xdg) {
    return join(xdg, 'staghorn');
  }
  return join(homedir(), '.staghorn');
}

/**
 * One file per route, rather than a single registry.json.
 *
 * The original single-file registry documented a race it could not fix: two dev
 * servers starting at the same moment both read, both mutate, and the second
 * write loses the first one's route. Splitting the directory removes the race
 * instead of guarding it - writers never touch each other's files, so no lock is
 * needed. That matters because a lock this design could take is a lock a SIGKILL
 * can leave behind, which is a worse failure than the one it prevents.
 */
export function routesDir(): string {
  return join(stateDir(), 'routes');
}

/** Path of the route file for a fully-qualified host (minus the tld). */
export function routePath(routeKey: string): string {
  return join(routesDir(), `${encodeRouteKey(routeKey)}.json`);
}

/**
 * Route keys are dotted hostnames (`storybook.feature-x.myapp`), which are legal
 * filenames but let a hostile or merely odd label escape the directory (`..`) or
 * collide across platforms. Percent-encode everything outside the DNS-safe set.
 */
export function encodeRouteKey(routeKey: string): string {
  return routeKey.replace(
    /[^a-z0-9.-]/gi,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** Inverse of {@link encodeRouteKey}, for listing the directory. */
export function decodeRouteKey(fileName: string): string {
  return fileName
    .replace(/\.json$/, '')
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

/**
 * Where the running daemon advertises the address it actually bound.
 *
 * Clients must never assume :80. The daemon walks a fallback ladder (wildcard :80
 * -> shared high port -> nothing), so the port it ends up on is a runtime fact,
 * not a constant. Publishing it here is what makes the alternate-port rung, the
 * in-process mode, multi-user machines and CI on Linux all work from one code
 * path instead of four.
 */
export function daemonInfoPath(): string {
  return join(stateDir(), 'daemon.json');
}

export function proxyLogPath(): string {
  return join(stateDir(), 'proxy.log');
}

/**
 * Directory the daemon is copied into when the installed package is readable but
 * not spawnable - see resolve-proxy-entry.ts.
 */
export function relocatedDaemonDir(): string {
  return join(stateDir(), 'bin');
}
