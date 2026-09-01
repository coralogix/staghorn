import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from './log';
import {
  DEFAULT_SHARED_PORT,
  DEFAULT_WILDCARD_PORT,
  PROTOCOL_VERSION,
  PROXY_NAME,
  type ProbeOutcome,
  type ProxyStatus,
} from './protocol';
import { ensureProxy, type EnsureProxyDeps, type EnsureProxyOptions } from './ensure-proxy';

describe('ensureProxy rung 1 (wildcard)', () => {
  it('adopts a daemon already on the wildcard port and reports no port', async () => {
    const result = await run({}, { onPort: { [DEFAULT_WILDCARD_PORT]: ours() } });
    expect(result.mode).toBe('wildcard');
    // null is the portless case, which is the entire point of rung 1.
    expect(result.proxyPort).toBeNull();
    expect(result.started).toBe(false);
  });

  it('starts one when nothing is listening', async () => {
    const { result, spawned } = await runTracking();
    expect(result.mode).toBe('wildcard');
    expect(result.started).toBe(true);
    expect(spawned).toEqual([DEFAULT_WILDCARD_PORT]);
  });
});

describe('ensureProxy rung 2 (shared port)', () => {
  // The Linux default: the wildcard bind is refused, so the daemon never appears
  // on :80 and the ladder lands on a port that needs no privileges.
  it('lands on the shared port when the wildcard bind is refused', async () => {
    const { result, spawned } = await runTracking({
      comesUpOn: [DEFAULT_SHARED_PORT],
    });
    expect(result.mode).toBe('sharedPort');
    expect(result.proxyPort).toBe(DEFAULT_SHARED_PORT);
    expect(spawned).toEqual([DEFAULT_WILDCARD_PORT, DEFAULT_SHARED_PORT]);
  });

  it('skips a rung owned by something foreign instead of fighting for it', async () => {
    const { result, spawned } = await runTracking({
      onPort: { [DEFAULT_WILDCARD_PORT]: { kind: 'foreign' } },
      comesUpOn: [DEFAULT_SHARED_PORT],
    });
    expect(result.mode).toBe('sharedPort');
    expect(spawned).toEqual([DEFAULT_SHARED_PORT]);
  });

  it('adopts a daemon already on the shared port', async () => {
    const result = await run(
      {},
      {
        onPort: {
          [DEFAULT_WILDCARD_PORT]: { kind: 'foreign' },
          [DEFAULT_SHARED_PORT]: ours({ port: DEFAULT_SHARED_PORT }),
        },
      },
    );
    expect(result.mode).toBe('sharedPort');
    expect(result.proxyPort).toBe(DEFAULT_SHARED_PORT);
  });
});

describe('ensureProxy rung 0 (direct)', () => {
  it('degrades to direct when nothing can bind', async () => {
    const { result } = await runTracking({ comesUpOn: [] });
    expect(result.mode).toBe('direct');
    expect(result.reason).toBe('bind-denied');
    expect(result.proxyPort).toBeNull();
  });

  it('degrades to direct when every rung is foreign', async () => {
    const result = await run(
      {},
      {
        onPort: {
          [DEFAULT_WILDCARD_PORT]: { kind: 'foreign' },
          [DEFAULT_SHARED_PORT]: { kind: 'foreign' },
        },
      },
    );
    expect(result.mode).toBe('direct');
    expect(result.reason).toBe('port-in-use-foreign');
  });

  it('degrades to direct when the daemon file cannot be found', async () => {
    const result = await run(
      {},
      { entry: null },
    );
    expect(result.mode).toBe('direct');
    expect(result.reason).toBe('no-daemon-entry');
  });

  it('reports disabled without probing anything', async () => {
    let probes = 0;
    const result = await run(
      { enabled: false },
      {
        probe: async () => {
          probes++;
          return { kind: 'absent' };
        },
      },
    );
    expect(result).toMatchObject({ mode: 'direct', reason: 'disabled' });
    expect(probes).toBe(0);
  });

  // The contract the whole design rests on: this can never break a dev server.
  it('never throws when spawning fails outright', async () => {
    const result = await run(
      {},
      {
        spawnDaemon: () => {
          throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
        },
      },
    );
    expect(result.mode).toBe('direct');
  });
});

describe('ensureProxy safety checks', () => {
  it('will not share a daemon speaking a different protocol major', async () => {
    const { result, logger } = await runWithLogger({
      onPort: {
        [DEFAULT_WILDCARD_PORT]: ours({ protocol: PROTOCOL_VERSION + 1 }),
        [DEFAULT_SHARED_PORT]: ours({ port: DEFAULT_SHARED_PORT }),
      },
    });
    expect(result.mode).toBe('sharedPort');
    expect(
      logger.records.some((record) => record.msg.includes('protocol v')),
    ).toBe(true);
  });

  // On a shared machine the predecessor would happily adopt - and shut down -
  // another developer's daemon.
  it("will not adopt another user's daemon", async () => {
    const { result, logger } = await runWithLogger({
      onPort: {
        [DEFAULT_WILDCARD_PORT]: ours({ uid: 999_999 }),
        [DEFAULT_SHARED_PORT]: ours({ port: DEFAULT_SHARED_PORT, uid: 1000 }),
      },
      // Injected so this asserts the RULE rather than the host's uid support. Left
      // to the platform, this passed on Linux and macOS while the very same code
      // path silently disabled the tool on Windows.
      isForeignOwner: (uid) => uid === 999_999,
    });
    expect(result.mode).toBe('sharedPort');
    expect(
      logger.records.some((record) => record.msg.includes('another user')),
    ).toBe(true);
  });

  // The Windows case, and the reason the gate asks "positively foreign" rather than
  // "positively mine": a platform with no uid reports null on both sides, so the
  // stricter question is false for our OWN daemon and every dev server would
  // degrade to direct URLs permanently.
  it('adopts a daemon whose ownership cannot be determined', async () => {
    const result = await run(
      {},
      {
        onPort: { [DEFAULT_WILDCARD_PORT]: ours({ uid: null }) },
        isForeignOwner: () => false,
      },
    );
    expect(result.mode).toBe('wildcard');
    expect(result.started).toBe(false);
  });

  it('uses a legacy daemon but says it needs restarting', async () => {
    const { result, logger } = await runWithLogger({
      onPort: {
        [DEFAULT_WILDCARD_PORT]: {
          kind: 'legacy',
          status: status({ name: 'cx-dev-domains-proxy' }),
        },
      },
    });
    expect(result.mode).toBe('wildcard');
    expect(result.reason).toBe('ok');
    expect(
      logger.records.some((record) => record.msg.includes('needs a restart')),
    ).toBe(true);
  });
});

describe('ensureProxy advertised daemon', () => {
  it('adopts the advertised daemon without probing other rungs', async () => {
    let probes = 0;
    const result = await run(
      {},
      {
        advertised: { pid: 4242, port: DEFAULT_WILDCARD_PORT },
        alivePids: [4242],
        probe: async (port) => {
          probes++;
          return port === DEFAULT_WILDCARD_PORT ? ours() : { kind: 'absent' };
        },
      },
    );
    expect(result.mode).toBe('wildcard');
    expect(probes).toBe(1);
  });

  // A SIGKILLed daemon never clears its file, so a stale record is ordinary.
  it('ignores an advertisement whose process is gone', async () => {
    const { result, spawned } = await runTracking({
      advertised: { pid: 4242, port: DEFAULT_WILDCARD_PORT },
      alivePids: [],
    });
    expect(result.started).toBe(true);
    expect(spawned).toEqual([DEFAULT_WILDCARD_PORT]);
  });
});

describe('ensureProxy forced modes', () => {
  it('honours a forced shared-port mode without trying the wildcard', async () => {
    const { result, spawned } = await runTracking(
      { comesUpOn: [DEFAULT_SHARED_PORT] },
      { mode: 'sharedPort' },
    );
    expect(result.mode).toBe('sharedPort');
    expect(spawned).toEqual([DEFAULT_SHARED_PORT]);
  });

  it('honours a forced direct mode', async () => {
    const result = await run({ mode: 'direct' }, {});
    expect(result).toMatchObject({ mode: 'direct', reason: 'ok' });
  });
});

// --- harness -------------------------------------------------------------

interface Stage {
  onPort?: Record<number, ProbeOutcome>;
  comesUpOn?: readonly number[];
  entry?: string | null;
  advertised?: { pid: number; port: number } | null;
  alivePids?: readonly number[];
  probe?: EnsureProxyDeps['probe'];
  spawnDaemon?: EnsureProxyDeps['spawnDaemon'];
  isForeignOwner?: EnsureProxyDeps['isForeignOwner'];
}

function deps(
  stage: Stage,
  extra: { spawned?: number[]; logger?: ReturnType<typeof createRecordingLogger> } = {},
): EnsureProxyDeps {
  const {
    onPort = {},
    comesUpOn = [DEFAULT_WILDCARD_PORT],
    entry = '/pkg/dist/proxy.mjs',
    advertised = null,
    alivePids = [],
  } = stage;
  const started = new Set<number>();

  return {
    logger: extra.logger ?? createRecordingLogger(),
    entryResolver: { resolve: () => entry, reset: () => {} },
    isAlive: (pid) => alivePids.includes(pid),
    // Default to "nothing is foreign", so the fixtures do not depend on whether the
    // host platform has uids at all.
    isForeignOwner: stage.isForeignOwner ?? (() => false),
    // No real waiting: the ladder's timing is not what these tests are about.
    delay: () => Promise.resolve(),
    daemonInfo: {
      read: async () =>
        advertised
          ? {
              schemaVersion: 1,
              name: PROXY_NAME,
              protocol: PROTOCOL_VERSION,
              version: '1.0.0',
              pid: advertised.pid,
              port: advertised.port,
              host: null,
              uid: currentUid(),
              stateDir: '/state',
              startedAt: 0,
            }
          : null,
      readSync: () => null,
      write: async () => {
        throw new Error('not used');
      },
      clear: async () => {},
      clearSync: () => {},
    },
    probe:
      stage.probe ??
      (async (port: number) => {
        const staged = onPort[port];
        if (staged) {
          return staged;
        }
        if (started.has(port) && comesUpOn.includes(port)) {
          return ours({ port });
        }
        return { kind: 'absent' };
      }),
    spawnDaemon:
      stage.spawnDaemon ??
      ((port) => {
        extra.spawned?.push(port);
        started.add(port);
      }),
  };
}

function run(options: EnsureProxyOptions, stage: Stage): ReturnType<typeof ensureProxy> {
  return ensureProxy(options, deps(stage));
}

async function runTracking(
  stage: Stage = {},
  options: EnsureProxyOptions = {},
): Promise<{ result: Awaited<ReturnType<typeof ensureProxy>>; spawned: number[] }> {
  const spawned: number[] = [];
  const result = await ensureProxy(options, deps(stage, { spawned }));
  return { result, spawned };
}

async function runWithLogger(stage: Stage): Promise<{
  result: Awaited<ReturnType<typeof ensureProxy>>;
  logger: ReturnType<typeof createRecordingLogger>;
}> {
  const logger = createRecordingLogger();
  const result = await ensureProxy({}, deps(stage, { logger }));
  return { result, logger };
}

function ours(overrides: Partial<ProxyStatus> = {}): ProbeOutcome {
  return { kind: 'ours', status: status(overrides) };
}

function status(overrides: Partial<ProxyStatus> = {}): ProxyStatus {
  return {
    name: PROXY_NAME,
    protocol: PROTOCOL_VERSION,
    version: '1.0.0',
    pid: 1234,
    routes: 0,
    leases: 0,
    port: DEFAULT_WILDCARD_PORT,
    uid: currentUid(),
    stateDir: '/state',
    ...overrides,
  };
}

function currentUid(): number | null {
  const uid = process.getuid?.();
  return typeof uid === 'number' ? uid : null;
}

describe('ensureProxy spawn: false', () => {
  // `daemon.mode: 'external'` was documented in the config types from the first
  // release and silently did nothing - ensureProxy always spawned. This is the
  // behaviour it was supposed to have.
  it('adopts a running daemon without spawning', async () => {
    const { result, spawned } = await runTracking(
      { onPort: { [DEFAULT_WILDCARD_PORT]: ours() } },
      { spawn: false },
    );
    expect(result.mode).toBe('wildcard');
    expect(result.started).toBe(false);
    expect(spawned).toEqual([]);
  });

  it('falls to direct rather than starting one', async () => {
    const { result, spawned } = await runTracking({}, { spawn: false });
    expect(result).toMatchObject({ mode: 'direct', reason: 'not-spawned' });
    expect(spawned).toEqual([]);
  });
});
