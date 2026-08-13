// Ties the shared daemon's lifetime to the dev servers it exists to serve.
//
// Every dev server holds one open "lease" connection for as long as it runs. The
// OS closes that socket however the server ends - clean exit, Ctrl-C, a crash,
// even SIGKILL - so the daemon learns a dev server is gone from a socket 'close'
// event: exact, immediate, and with nothing sampling anything on a timer. When the
// last lease closes the daemon exits, and the next dev server boots a fresh one.
// A machine-wide daemon therefore never outlives the work it was started for.

import { systemClock, type Timers, type TimerHandle } from '../clock';

/**
 * All a lease is, from the tracker's side: something that reports when it closes
 * and can be ended.
 *
 * Structural on purpose - an http ServerResponse satisfies it, and so does a
 * plain object in a test. This is what keeps the lifetime policy free of
 * node:http and testable without sockets.
 */
export interface LeaseConnection {
  on(event: 'close', listener: () => void): unknown;
  end(): void;
}

/**
 * Grace after the last lease closes. Long enough that restarting a dev server in
 * place - or moving between two worktrees - reuses the running daemon instead of
 * paying a respawn, short enough that a finished session leaves nothing behind.
 */
export const LEASE_LINGER_MS = 5_000;

/**
 * Grace at boot, before any lease exists. A dev server spawns the daemon and
 * leases it a moment later; if it dies in between - or someone starts the daemon
 * by hand - nobody will ever lease it, and it must not linger forever.
 */
export const LEASE_BOOT_GRACE_MS = 30_000;

/**
 * Cap on concurrent leases. One per running dev server, so this sits far above
 * real use. It exists because the daemon is a shared singleton, and an unbounded
 * endpoint that holds sockets open is a file-descriptor sink.
 */
export const MAX_LEASES = 32;

export interface LeaseTrackerOptions {
  /** Called at most once, when no lease has been held for a whole grace window. */
  readonly onIdle: () => void;
  readonly lingerMs?: number;
  readonly bootGraceMs?: number;
  readonly maxLeases?: number;
  readonly timers?: Timers;
}

export interface LeaseTracker {
  /** Arm the boot grace. Call once the daemon is listening. */
  start(): void;
  /**
   * Hold a lease until its socket closes. False when the cap is hit or the
   * daemon is already shutting down, so the caller can answer 503 rather than
   * silently keeping a socket that means nothing.
   */
  hold(connection: LeaseConnection): boolean;
  /** Leases currently held - one per running dev server. */
  readonly size: number;
  /** End every held lease, so dev servers see a clean close. */
  closeAll(): void;
  /** Cancel any pending idle timer. For teardown in the in-process mode. */
  stop(): void;
}

export function createLeaseTracker({
  onIdle,
  lingerMs = LEASE_LINGER_MS,
  bootGraceMs = LEASE_BOOT_GRACE_MS,
  maxLeases = MAX_LEASES,
  timers = systemClock,
}: LeaseTrackerOptions): LeaseTracker {
  const leases = new Set<LeaseConnection>();
  let timer: TimerHandle = null;
  let fired = false;

  // An already-armed timer is left alone rather than restarted, so a boot grace
  // can never be shortened into a linger by an unrelated event.
  const armIdleExit = (ms: number): void => {
    if (fired || timer !== null) {
      return;
    }
    timer = timers.setTimeout(() => {
      timer = null;
      if (leases.size > 0) {
        return;
      }
      fired = true;
      onIdle();
    }, ms);
  };

  const cancelIdleExit = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  return {
    start: () => armIdleExit(bootGraceMs),

    hold: (connection) => {
      if (fired || leases.size >= maxLeases) {
        return false;
      }
      leases.add(connection);
      cancelIdleExit();
      // 'close' covers every way a dev server can end, including the ones it
      // never gets to react to: the socket is closed by the OS, not by the peer
      // being polite.
      connection.on('close', () => {
        leases.delete(connection);
        if (leases.size === 0) {
          armIdleExit(lingerMs);
        }
      });
      return true;
    },

    get size() {
      return leases.size;
    },

    closeAll: () => {
      for (const connection of leases) {
        connection.end();
      }
      leases.clear();
    },

    stop: cancelIdleExit,
  };
}

// Deliberately absent, and worth recording so neither comes back by accident.
//
// `hasUnleasedServer` + the timer re-arm it required: both existed only for the
// window in which a dev server from a pre-lease checkout could route through the
// daemon without leasing it. Exiting under such a server would have broken its
// URL mid-session, and because a SIGKILLed unleased server writes nothing, the
// only way to notice was to re-arm and look again - the single non-event-driven
// path in the whole daemon. Every client in this package leases, so the branch is
// unreachable and goes with it.
//
// `recheck()`: it armed the linger when the lease count was already zero, which
// the 'close' handler above does, and covered the never-leased case, which
// `start()`'s boot grace covers. With no reachable caller it is dead code.
