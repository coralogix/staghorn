// SPDX-License-Identifier: Apache-2.0
//
// The daemon entry point, and the detach hop.
//
// Deliberately thin: it reads its configuration out of the environment, calls
// createProxy, and exits when the proxy stops. All the behaviour lives in
// create-proxy.ts, which is ordinary testable code with no side effects at import
// time. Nothing here should ever grow logic worth a test.
//
// Two modes:
//   node <this file> --detach   re-spawn detached, then exit (the launcher hop)
//   node <this file>            be the daemon
//
// The hop is not tidiness. Stopping a dev server gracefully kills its descendant
// process tree by pid, so a daemon spawned directly by one dev server is torn down
// by the first Ctrl-C - taking shared routing away from every other checkout still
// serving. Re-spawning and exiting reparents the daemon to init/launchd, out of
// anyone's tree.
//
// The hop re-spawns its OWN import.meta.url, so the path is resolved exactly once,
// by the caller. That halves the surface area of the spawn-path problem and means
// a relocated copy of this file keeps working without knowing it was moved.

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { errorMessage } from '../errors';
import { DEFAULT_TLD } from '../host';
import { createLogger, type LogLevel } from '../log';
import { proxyLogPath, stateDir } from '../paths';
import { DEFAULT_SHARED_PORT, isLoopbackAddress } from '../protocol';
import { VERSION } from '../version';
import { createProxy, type ProxyOptions } from './create-proxy';

const DETACH_FLAG = '--detach';

if (process.argv.slice(2).includes(DETACH_FLAG)) {
  await detach();
} else {
  await run();
}

async function detach(): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  const logFd = openSync(proxyLogPath(), 'a');
  try {
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // Windows would otherwise flash a console window for the daemon.
      windowsHide: true,
    });
    // An 'error' event with no listener is re-thrown by Node in THIS process. A
    // spawn hiccup (EAGAIN/EMFILE - exactly what several dev servers starting at
    // once can produce) must not become an unhandled throw.
    child.on('error', (err) => {
      process.stderr.write(
        `[staghorn] could not spawn daemon: ${errorMessage(err)}\n`,
      );
      process.exitCode = 1;
    });
    child.unref();
  } finally {
    // spawn dups the fd into the child; close this process's copy.
    closeSync(logFd);
  }
}

async function run(): Promise<void> {
  const logger = createLogger({ level: logLevel() });
  const trustAny = process.env['STAGHORN_TRUST']?.trim() === 'any';
  const port = listenPort();

  const options: ProxyOptions = {
    listen: { port, host: bindHost() },
    tld: process.env['STAGHORN_TLD']?.trim() || DEFAULT_TLD,
  };
  const hint = process.env['STAGHORN_LIST_COMMAND']?.trim();

  try {
    const proxy = await createProxy(hint ? { ...options, listCommand: hint } : options, {
      logger,
      version: VERSION,
      // Trusting non-loopback clients undoes the guarantee that makes the wildcard
      // bind safe, so it is opt-in, explicit, and announced every time.
      isTrustedClient: trustAny ? () => true : isLoopbackAddress,
    });
    if (trustAny) {
      logger.warn(
        'serving NON-LOOPBACK clients because STAGHORN_TRUST=any; this port is reachable from every network this machine joins',
      );
    }
    const reason = await proxy.closed;
    logger.info('stopped', { reason });
    // Explicit exit rather than falling off the end: idle keep-alive sockets can
    // keep the loop alive briefly, and a daemon that has decided to stop should.
    process.exit(0);
  } catch (err) {
    // EACCES (an unprivileged wildcard :80 on stock Linux) and EADDRINUSE
    // (something else owns the port) both land here. Exit non-zero and let the
    // caller ladder down - it probes, sees nothing of ours, and picks the next
    // rung. Never a crash a developer has to interpret.
    logger.error(`cannot bind :${port}: ${errorMessage(err)}`);
    process.exit(1);
  }
}

function listenPort(): number {
  const raw = process.env['STAGHORN_PORT']?.trim();
  if (!raw) {
    return DEFAULT_SHARED_PORT;
  }
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 0 && port <= 65_535
    ? port
    : DEFAULT_SHARED_PORT;
}

// Empty means the wildcard, which is what makes the unprivileged :80 bind work.
function bindHost(): string | null {
  return process.env['STAGHORN_BIND']?.trim() || null;
}

function logLevel(): LogLevel {
  const raw = process.env['STAGHORN_LOG']?.trim();
  return raw === 'silent' ||
    raw === 'error' ||
    raw === 'warn' ||
    raw === 'info' ||
    raw === 'debug'
    ? raw
    : 'info';
}
