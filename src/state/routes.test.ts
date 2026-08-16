import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from '../log';
import {
  ROUTE_SCHEMA_VERSION,
  createFileRouteStore,
  isPidAlive,
  type RouteInput,
  type RouteStore,
  type WatchStrategy,
} from './routes';

describe('createFileRouteStore', () => {
  it('round-trips a route', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'main.myapp', port: 4301 }));

    const snapshot = await store.read();
    expect(snapshot.size).toBe(1);
    expect(snapshot.get('main.myapp')?.port).toBe(4301);
    expect(snapshot.has('main.myapp')).toBe(true);
  });

  it('stamps the schema version and a creation time', async () => {
    const { store } = harness({ now: () => 1_700_000_000_000 });
    const saved = await store.upsert(route({ routeKey: 'main.myapp' }));
    expect(saved.schemaVersion).toBe(ROUTE_SCHEMA_VERSION);
    expect(saved.createdAt).toBe(1_700_000_000_000);
  });

  it('reads the same state synchronously', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'main.myapp', port: 4302 }));
    expect(store.readSync().get('main.myapp')?.port).toBe(4302);
  });

  it('returns an empty snapshot when the state dir does not exist yet', async () => {
    const { store } = harness({ createDir: false });
    expect((await store.read()).size).toBe(0);
    expect(store.readSync().size).toBe(0);
  });

  it('keeps multi-label route keys, including service routes', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'storybook.feature-x.myapp' }));
    await store.upsert(route({ routeKey: 'feature-x.myapp' }));

    const snapshot = await store.read();
    expect([...snapshot.routes.keys()].sort()).toEqual([
      'feature-x.myapp',
      'storybook.feature-x.myapp',
    ]);
  });

  // Two dev servers starting together was the documented, unfixable race in the
  // single-file design. With one file per key it is not a race at all.
  it('does not lose a concurrent write of a different route', async () => {
    const { store } = harness();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.upsert(route({ routeKey: `b-${i}.myapp`, port: 4300 + i })),
      ),
    );
    expect((await store.read()).size).toBe(12);
  });

  it('leaves no temp files behind', async () => {
    const { store, dir } = harness();
    await store.upsert(route({ routeKey: 'main.myapp' }));
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('percent-encodes route keys that are unsafe as filenames', async () => {
    const { store, dir } = harness();
    await store.upsert(route({ routeKey: 'a/../b.myapp' }));
    // Whatever landed on disk must be a single flat file in the state dir.
    expect(readdirSync(dir)).toHaveLength(1);
    expect((await store.read()).has('a/../b.myapp')).toBe(true);
  });

  it('treats a prototype-named route as an ordinary key', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: '__proto__' }));
    await store.upsert(route({ routeKey: 'constructor' }));

    const snapshot = await store.read();
    expect(snapshot.has('__proto__')).toBe(true);
    expect(snapshot.has('constructor')).toBe(true);
    expect(snapshot.has('main.myapp')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });
});

describe('createFileRouteStore corrupt input', () => {
  it('skips unparseable and malformed files without failing the read', async () => {
    const { store, dir, logger } = harness();
    await store.upsert(route({ routeKey: 'good.myapp' }));
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ hello: 1 }), 'utf8');

    const snapshot = await store.read();
    expect([...snapshot.routes.keys()]).toEqual(['good.myapp']);
    expect(logger.records.some((r) => r.level === 'debug')).toBe(true);
  });

  it('skips a route whose port is unusable', async () => {
    const { store, dir } = harness();
    writeFileSync(
      join(dir, 'bad-port.json'),
      JSON.stringify({ ...rawRoute('bad-port'), port: 0 }),
      'utf8',
    );
    expect((await store.read()).size).toBe(0);
  });

  it('skips a file whose contents disagree with its filename', async () => {
    const { store, dir } = harness();
    writeFileSync(
      join(dir, 'claimed.json'),
      JSON.stringify(rawRoute('something-else')),
      'utf8',
    );
    expect((await store.read()).size).toBe(0);
  });

  // An old client must never be able to corrupt a newer client's state.
  it('ignores but preserves a route from a newer schema', async () => {
    const { store, dir } = harness();
    writeFileSync(
      join(dir, 'future.json'),
      JSON.stringify({
        ...rawRoute('future'),
        schemaVersion: ROUTE_SCHEMA_VERSION + 1,
      }),
      'utf8',
    );
    expect((await store.read()).size).toBe(0);
    expect(readdirSync(dir)).toContain('future.json');
  });
});

describe('createFileRouteStore.remove', () => {
  it('removes a route', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'main.myapp' }));
    expect(await store.remove('main.myapp')).toBe(true);
    expect((await store.read()).size).toBe(0);
  });

  it('reports false for a route that is not there', async () => {
    const { store } = harness();
    expect(await store.remove('missing.myapp')).toBe(false);
  });

  // A dying serve must not delete the route a newer serve just claimed for the
  // same host - otherwise Ctrl-C in one worktree silently unroutes another.
  it('refuses to remove a route owned by a different pid', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'main.myapp', pid: 4242 }));
    expect(await store.remove('main.myapp', 9999)).toBe(false);
    expect((await store.read()).size).toBe(1);
    expect(await store.remove('main.myapp', 4242)).toBe(true);
  });

  it('applies the same ownership check synchronously', async () => {
    const { store } = harness();
    await store.upsert(route({ routeKey: 'main.myapp', pid: 4242 }));
    expect(store.removeSync('main.myapp', 9999)).toBe(false);
    expect(store.removeSync('main.myapp', 4242)).toBe(true);
  });
});

describe('createFileRouteStore.prune', () => {
  it('drops routes whose process is gone and keeps the rest', async () => {
    const { store } = harness({ isAlive: (pid) => pid === 111 });
    await store.upsert(route({ routeKey: 'live.myapp', pid: 111 }));
    await store.upsert(route({ routeKey: 'dead.myapp', pid: 222 }));

    const result = await store.prune();
    expect(result.removed).toEqual(['dead.myapp']);
    expect(result.kept).toBe(1);
    expect([...(await store.read()).routes.keys()]).toEqual(['live.myapp']);
  });

  it('removes corrupt files it cannot attribute to a live process', async () => {
    const { store, dir } = harness({ isAlive: () => true });
    writeFileSync(join(dir, 'junk.json'), 'not json', 'utf8');
    await store.prune();
    expect(readdirSync(dir)).not.toContain('junk.json');
  });

  it('is a no-op on a missing state dir', async () => {
    const { store } = harness({ createDir: false });
    await expect(store.prune()).resolves.toEqual({ removed: [], kept: 0 });
  });
});

// Polling is the only strategy. fs.watch aborts the process on Windows and delivers
// unreliably through macOS's symlinked temp dir, so it is not used at all - which is
// also why these tests are deterministic rather than timing-tolerant.
describe('createFileRouteStore.watch', () => {
  it('notices a new route', async () => {
    const { store } = harness({ watchPollIntervalMs: 20 });
    let calls = 0;
    const stop = store.watch(() => {
      calls++;
    });
    try {
      await store.upsert(route({ routeKey: 'polled.myapp' }));
      await waitFor(() => calls >= 1);
    } finally {
      stop();
    }
  });

  it('notices a removed route', async () => {
    const { store } = harness({ watchPollIntervalMs: 20 });
    await store.upsert(route({ routeKey: 'doomed.myapp' }));
    let calls = 0;
    const stop = store.watch(() => {
      calls++;
    });
    try {
      await store.remove('doomed.myapp');
      await waitFor(() => calls >= 1);
    } finally {
      stop();
    }
  });

  it('coalesces a burst of changes into one notification', async () => {
    const { store } = harness({ watchPollIntervalMs: 20, watchDebounceMs: 60 });
    let calls = 0;
    const stop = store.watch(() => {
      calls++;
    });
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.upsert(route({ routeKey: `b-${i}.myapp` })),
        ),
      );
      await waitFor(() => calls >= 1);
      await settle(120);
      // Five writes are ten filesystem operations; coalescing is what stops the
      // daemon rebuilding its routing table ten times for one logical change.
      expect(calls).toBeLessThan(5);
    } finally {
      stop();
    }
  });

  it('stops notifying after unsubscribe', async () => {
    const { store } = harness({ watchPollIntervalMs: 20 });
    let calls = 0;
    store.watch(() => {
      calls++;
    })();
    await store.upsert(route({ routeKey: 'ignored.myapp' }));
    await settle(120);
    expect(calls).toBe(0);
  });

  it('is inert when watching is off', async () => {
    const { store } = harness({ watchStrategy: 'off', watchPollIntervalMs: 20 });
    let calls = 0;
    const stop = store.watch(() => {
      calls++;
    });
    await store.upsert(route({ routeKey: 'quiet.myapp' }));
    await settle(120);
    stop();
    expect(calls).toBe(0);
  });
});

describe('isPidAlive', () => {
  it('is true for this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('is false for nonsense pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

function harness({
  isAlive,
  now,
  watchDebounceMs,
  watchStrategy,
  watchPollIntervalMs,
  createDir = true,
}: {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  watchDebounceMs?: number;
  watchStrategy?: WatchStrategy;
  watchPollIntervalMs?: number;
  createDir?: boolean;
} = {}): {
  store: RouteStore;
  dir: string;
  logger: ReturnType<typeof createRecordingLogger>;
} {
  const base = mkdtempSync(join(tmpdir(), 'staghorn-test-'));
  const dir = join(base, 'routes');
  if (createDir) {
    mkdirSync(dir, { recursive: true });
  }
  const logger = createRecordingLogger();
  const store = createFileRouteStore({
    dir: () => dir,
    logger,
    ...(isAlive ? { isAlive } : {}),
    ...(now ? { now } : {}),
    ...(watchDebounceMs === undefined ? {} : { watchDebounceMs }),
    ...(watchStrategy ? { watchStrategy } : {}),
    ...(watchPollIntervalMs === undefined ? {} : { watchPollIntervalMs }),
  });
  return { store, dir, logger };
}

function route(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    routeKey: 'main.myapp',
    port: 4300,
    pid: process.pid,
    checkoutPath: '/repo',
    branch: 'main',
    project: 'myapp',
    service: null,
    ...overrides,
  };
}

function rawRoute(routeKey: string): Record<string, unknown> {
  return {
    schemaVersion: ROUTE_SCHEMA_VERSION,
    routeKey,
    port: 4300,
    pid: process.pid,
    checkoutPath: '/repo',
    branch: 'main',
    project: 'myapp',
    service: null,
    createdAt: 0,
  };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  { budgetMs = 2_000, stepMs = 20 }: { budgetMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${budgetMs}ms`);
    }
    await settle(stepMs);
  }
}
