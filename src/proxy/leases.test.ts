import { describe, expect, it } from 'vitest';

import { createFakeClock, type FakeClock } from '../clock';
import {
  LEASE_BOOT_GRACE_MS,
  LEASE_LINGER_MS,
  MAX_LEASES,
  createLeaseTracker,
  type LeaseConnection,
  type LeaseTracker,
} from './leases';

describe('createLeaseTracker boot grace', () => {
  it('exits when nobody ever leases it', () => {
    const { tracker, clock, idle } = harness();
    tracker.start();

    clock.advance(LEASE_BOOT_GRACE_MS - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });

  it('does not exit when a lease arrives inside the boot grace', () => {
    const { tracker, clock, idle } = harness();
    tracker.start();

    clock.advance(LEASE_BOOT_GRACE_MS - 1);
    tracker.hold(connection());
    clock.advance(LEASE_BOOT_GRACE_MS * 2);
    expect(idle()).toBe(0);
  });

  // A boot grace must never be shortened into a linger by an unrelated event.
  it('does not let a later arm shorten the boot grace', () => {
    const { tracker, clock, idle } = harness();
    tracker.start();
    tracker.start();

    clock.advance(LEASE_LINGER_MS + 1);
    expect(idle()).toBe(0);
    clock.advance(LEASE_BOOT_GRACE_MS);
    expect(idle()).toBe(1);
  });
});

describe('createLeaseTracker linger', () => {
  it('exits a linger after the last lease closes', () => {
    const { tracker, clock, idle } = harness();
    const lease = connection();
    tracker.hold(lease);

    lease.close();
    clock.advance(LEASE_LINGER_MS - 1);
    expect(idle()).toBe(0);
    clock.advance(1);
    expect(idle()).toBe(1);
  });

  // Restarting a dev server in place, or hopping worktrees, must reuse the daemon.
  it('cancels a pending exit when a new lease arrives', () => {
    const { tracker, clock, idle } = harness();
    const first = connection();
    tracker.hold(first);

    first.close();
    clock.advance(LEASE_LINGER_MS - 1);
    tracker.hold(connection());
    clock.advance(LEASE_LINGER_MS * 3);
    expect(idle()).toBe(0);
  });

  it('waits for the last of several leases', () => {
    const { tracker, clock, idle } = harness();
    const leases = [connection(), connection(), connection()];
    for (const lease of leases) {
      tracker.hold(lease);
    }
    expect(tracker.size).toBe(3);

    leases[0]?.close();
    leases[1]?.close();
    clock.advance(LEASE_LINGER_MS * 2);
    expect(idle()).toBe(0);
    expect(tracker.size).toBe(1);

    leases[2]?.close();
    clock.advance(LEASE_LINGER_MS);
    expect(idle()).toBe(1);
  });

  it('fires onIdle at most once', () => {
    const { tracker, clock, idle } = harness();
    const lease = connection();
    tracker.hold(lease);
    lease.close();

    clock.advance(LEASE_LINGER_MS * 10);
    expect(idle()).toBe(1);
  });

  it('refuses new leases once it has fired', () => {
    const { tracker, clock } = harness();
    const lease = connection();
    tracker.hold(lease);
    lease.close();
    clock.advance(LEASE_LINGER_MS);

    expect(tracker.hold(connection())).toBe(false);
  });
});

describe('createLeaseTracker cap', () => {
  it('accepts up to the cap and refuses beyond it', () => {
    const { tracker } = harness();
    for (let i = 0; i < MAX_LEASES; i++) {
      expect(tracker.hold(connection())).toBe(true);
    }
    expect(tracker.hold(connection())).toBe(false);
    expect(tracker.size).toBe(MAX_LEASES);
  });

  it('frees a slot when a lease closes', () => {
    const { tracker } = harness({ maxLeases: 2 });
    const first = connection();
    tracker.hold(first);
    tracker.hold(connection());
    expect(tracker.hold(connection())).toBe(false);

    first.close();
    expect(tracker.hold(connection())).toBe(true);
  });
});

describe('createLeaseTracker teardown', () => {
  it('ends every held lease on closeAll', () => {
    const { tracker } = harness();
    const leases = [connection(), connection()];
    for (const lease of leases) {
      tracker.hold(lease);
    }

    tracker.closeAll();
    expect(leases.every((lease) => lease.ended)).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it('stop cancels a pending idle exit', () => {
    const { tracker, clock, idle } = harness();
    tracker.start();
    tracker.stop();

    clock.advance(LEASE_BOOT_GRACE_MS * 2);
    expect(idle()).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

function harness({ maxLeases }: { maxLeases?: number } = {}): {
  tracker: LeaseTracker;
  clock: FakeClock;
  idle: () => number;
} {
  const clock = createFakeClock();
  let idleCalls = 0;
  const tracker = createLeaseTracker({
    onIdle: () => {
      idleCalls++;
    },
    timers: clock,
    ...(maxLeases === undefined ? {} : { maxLeases }),
  });
  return { tracker, clock, idle: () => idleCalls };
}

interface FakeLease extends LeaseConnection {
  close(): void;
  readonly ended: boolean;
}

function connection(): FakeLease {
  const listeners: Array<() => void> = [];
  let ended = false;
  return {
    on(_event, listener) {
      listeners.push(listener);
      return this;
    },
    end() {
      ended = true;
    },
    close() {
      for (const listener of listeners) {
        listener();
      }
    },
    get ended() {
      return ended;
    },
  };
}
