// Time is an injected dependency. The lease policy (linger, boot grace) is the
// one place where the tool's correctness is a function of elapsed time, and
// asserting on it must not mean sleeping in a test.
//
// Injected rather than leaning on vitest's global fake timers: the daemon opens
// real sockets in the same suites, and patching the global timers a socket
// depends on makes those tests flaky for reasons that have nothing to do with
// leases.

export type TimerHandle = unknown;

export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface Clock extends Timers {
  now(): number;
}

/**
 * Real timers, unreffed.
 *
 * Unref matters for the in-process mode: an embedded proxy must never be the
 * reason a consumer's own process refuses to exit. The daemon is held open by its
 * listening server, not by this timer, so unreffing costs nothing there.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) {
      clearTimeout(handle as NodeJS.Timeout);
    }
  },
};

export interface FakeClock extends Clock {
  /** Advance time, firing everything due at or before the new instant. */
  advance(ms: number): void;
  /** Timers still pending. */
  readonly pending: number;
}

/**
 * A deterministic clock for tests. Fires due callbacks in scheduled order, and
 * handles callbacks that schedule further timers while advancing.
 */
export function createFakeClock(startAt = 0): FakeClock {
  interface Scheduled {
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
  }

  let current = startAt;
  let nextId = 1;
  let scheduled: Scheduled[] = [];

  return {
    now: () => current,

    setTimeout: (callback, ms) => {
      const id = nextId++;
      scheduled.push({ id, dueAt: current + Math.max(0, ms), callback });
      return id;
    },

    clearTimeout: (handle) => {
      scheduled = scheduled.filter((timer) => timer.id !== handle);
    },

    advance: (ms) => {
      const target = current + ms;
      // Loop rather than iterate a snapshot: a callback may schedule another
      // timer that is itself due before `target`, and it has to fire in this pass.
      for (;;) {
        const due = scheduled
          .filter((timer) => timer.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
        if (!due) {
          break;
        }
        scheduled = scheduled.filter((timer) => timer.id !== due.id);
        current = due.dueAt;
        due.callback();
      }
      current = target;
    },

    get pending() {
      return scheduled.length;
    },
  };
}
