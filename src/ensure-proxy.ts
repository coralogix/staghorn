// Making sure a usable daemon exists, by walking the fallback ladder.
//
//   rung 1  wildcard :80          portless. macOS, most Windows, Linux w/ sysctl.
//   rung 2  shared high port      no privileges anywhere. Linux's default landing.
//   rung 0  direct                no proxy at all; plain localhost:<port>.
//
// The HOSTNAME is identical on every rung - only the port appears or disappears -
// so a bookmark survives a degrade. That is the whole reason the ladder is worth
// having rather than just failing.
//
// This function NEVER throws and never blocks a dev server from starting. Every
// failure resolves to a lower rung with one explanatory line. A dev tool that can
// take the developer's dev server down with it is not worth its convenience.

import { spawn } from 'node:child_process';

import { errorMessage } from './errors';
import { silentLogger, type Logger } from './log';
import {
  DEFAULT_SHARED_PORT,
  DEFAULT_WILDCARD_PORT,
  isProtocolCompatible,
  type ProxyStatus,
} from './protocol';
import {
  createProxyEntryResolver,
  nodeBinary,
  type ProxyEntryResolver,
} from './resolve-proxy-entry';
import {
  createDaemonInfoStore,
  isForeignUid,
  type DaemonInfoStore,
} from './state/daemon-info';
import { isPidAlive } from './state/routes';
import { probeProxy } from './control-client';

/** Which rung the ladder settled on. */
export type ProxyMode = 'wildcard' | 'sharedPort' | 'direct';

export type FallbackReason =
  | 'ok'
  | 'disabled'
  | 'port-in-use-foreign'
  | 'bind-denied'
  | 'spawn-failed'
  | 'no-daemon-entry'
  | 'protocol-mismatch'
  | 'other-user';

export interface EnsuredProxy {
  readonly mode: ProxyMode;
  /**
   * Port the daemon listens on, or null in wildcard mode - which is what makes the
   * URL portless. `direct` also reports null; there is no proxy.
   */
  readonly proxyPort: number | null;
  readonly reason: FallbackReason;
  /** Whether we started it, for a caller that wants to say so. */
  readonly started: boolean;
  readonly status: ProxyStatus | null;
}

export interface EnsureProxyOptions {
  readonly enabled?: boolean;
  /** Force a rung instead of walking the ladder. */
  readonly mode?: 'auto' | ProxyMode;
  readonly wildcardPort?: number;
  readonly sharedPort?: number;
  /** Path to the daemon, when the caller already knows it. */
  readonly proxyEntry?: string | null;
  /** Extra environment for the spawned daemon. */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnPollAttempts?: number;
  readonly spawnPollIntervalMs?: number;
}

export interface EnsureProxyDeps {
  readonly logger?: Logger;
  readonly daemonInfo?: DaemonInfoStore;
  readonly entryResolver?: ProxyEntryResolver;
  readonly probe?: typeof probeProxy;
  readonly spawnDaemon?: (port: number, env: NodeJS.ProcessEnv) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Whether a uid is positively someone else's.
   *
   * Injected so the ownership rule can be asserted on every platform. Left to the
   * host, the assertion would depend on whether the CI runner has uids at all -
   * which is exactly the difference that hid a Windows-only bug here.
   */
  readonly isForeignOwner?: (uid: number | null) => boolean;
}

// Generous enough for two node startups - the spawn goes through the detach hop -
// on a machine already busy building several checkouts.
const SPAWN_POLL_ATTEMPTS = 15;
const SPAWN_POLL_INTERVAL_MS = 200;

export async function ensureProxy(
  options: EnsureProxyOptions = {},
  deps: EnsureProxyDeps = {},
): Promise<EnsuredProxy> {
  const {
    enabled = true,
    mode = 'auto',
    wildcardPort = DEFAULT_WILDCARD_PORT,
    sharedPort = DEFAULT_SHARED_PORT,
    proxyEntry = null,
    env = {},
    spawnPollAttempts = SPAWN_POLL_ATTEMPTS,
    spawnPollIntervalMs = SPAWN_POLL_INTERVAL_MS,
  } = options;
  const {
    logger = silentLogger,
    daemonInfo = createDaemonInfoStore(),
    entryResolver = createProxyEntryResolver({ logger }),
    probe = probeProxy,
    isAlive = isPidAlive,
    delay = defaultDelay,
    isForeignOwner = isForeignUid,
  } = deps;

  if (!enabled || mode === 'direct') {
    return direct(enabled ? 'ok' : 'disabled');
  }

  // Rungs to consider, in order. A forced mode narrows the ladder to one rung
  // rather than taking a different code path.
  const rungs: Array<{ mode: ProxyMode; port: number }> =
    mode === 'wildcard'
      ? [{ mode: 'wildcard', port: wildcardPort }]
      : mode === 'sharedPort'
        ? [{ mode: 'sharedPort', port: sharedPort }]
        : [
            { mode: 'wildcard', port: wildcardPort },
            { mode: 'sharedPort', port: sharedPort },
          ];

  // 1. A daemon we already advertised is the cheapest possible answer: no probe of
  //    a port nobody is on, no spawn.
  const advertised = await adoptAdvertised(rungs);
  if (advertised) {
    return advertised;
  }

  // 2. Probe each rung. Something of ours already there wins; something foreign
  //    means skip the rung rather than fight for the port.
  const spawnable: Array<{ mode: ProxyMode; port: number }> = [];
  for (const rung of rungs) {
    const outcome = await probe(rung.port);
    if (outcome.kind === 'ours') {
      const adopted = adopt(rung, outcome.status, false);
      if (adopted) {
        return adopted;
      }
      continue;
    }
    if (outcome.kind === 'legacy') {
      // A daemon from before this package. Routing still works, so use it, but say
      // what to do about it - the alternative is silently losing new behaviour.
      logger.warn(
        `an older staghorn daemon (${outcome.status.name}, pid ${outcome.status.pid}) owns :${rung.port}; ` +
          'routing works, but new behaviour needs a restart - stop it and re-run',
      );
      return {
        mode: rung.mode,
        proxyPort: portFor(rung),
        reason: 'ok',
        started: false,
        status: outcome.status,
      };
    }
    if (outcome.kind === 'foreign') {
      logger.info(
        `something other than staghorn owns :${rung.port}; trying the next option`,
      );
      continue;
    }
    spawnable.push(rung);
  }

  // 3. Nothing running. Start one, lowest rung number first.
  const entry = entryResolver.resolve(proxyEntry);
  if (entry === null) {
    return direct('no-daemon-entry');
  }
  const spawnDaemon =
    deps.spawnDaemon ?? ((port, environment) => launch(entry, port, environment));

  for (const rung of spawnable) {
    try {
      spawnDaemon(rung.port, { ...env, STAGHORN_PORT: String(rung.port) });
    } catch (err) {
      logger.warn(`could not start the daemon on :${rung.port}: ${errorMessage(err)}`);
      continue;
    }
    const status = await pollForDaemon(rung.port);
    if (status) {
      logger.info(`started the staghorn daemon on :${rung.port}`);
      return {
        mode: rung.mode,
        proxyPort: portFor(rung),
        reason: 'ok',
        started: true,
        status,
      };
    }
    // The overwhelmingly common cause on rung 1 outside macOS: the OS refuses an
    // unprivileged bind below 1024. Not an error - the next rung is designed for it.
    logger.info(
      `the daemon did not come up on :${rung.port}` +
        (rung.mode === 'wildcard'
          ? ' (an unprivileged bind below 1024 is not permitted here)'
          : ''),
    );
  }

  return direct(spawnable.length === 0 ? 'port-in-use-foreign' : 'bind-denied');

  async function pollForDaemon(port: number): Promise<ProxyStatus | null> {
    for (let attempt = 0; attempt < spawnPollAttempts; attempt++) {
      await delay(spawnPollIntervalMs);
      const outcome = await probe(port);
      if (outcome.kind === 'ours') {
        return outcome.status;
      }
      if (outcome.kind === 'foreign') {
        // Someone else claimed the port while we were starting.
        return null;
      }
    }
    return null;
  }

  async function adoptAdvertised(
    candidates: ReadonlyArray<{ mode: ProxyMode; port: number }>,
  ): Promise<EnsuredProxy | null> {
    const info = await daemonInfo.read().catch(() => null);
    // A SIGKILLed daemon never clears its file, so a stale record is ordinary,
    // not exceptional. Treating "file exists" as "daemon is up" would make every
    // caller wait out a probe timeout against a dead port.
    if (!info || !isAlive(info.pid)) {
      return null;
    }
    const rung = candidates.find((candidate) => candidate.port === info.port);
    if (!rung) {
      return null;
    }
    const outcome = await probe(info.port);
    return outcome.kind === 'ours' ? adopt(rung, outcome.status, false) : null;
  }

  function adopt(
    rung: { mode: ProxyMode; port: number },
    status: ProxyStatus,
    started: boolean,
  ): EnsuredProxy | null {
    if (!isProtocolCompatible(status.protocol)) {
      // Routing semantics can differ across protocol majors, so sharing would
      // mis-route rather than fail. Skip the rung; the ladder finds another.
      logger.info(
        `a daemon speaking protocol v${status.protocol} owns :${rung.port}; trying the next option`,
      );
      return null;
    }
    // Never adopt a daemon belonging to someone else. Note this asks "is it
    // POSITIVELY foreign", not "is it positively mine": unknown ownership is not
    // evidence of foreign ownership, and on a platform with no uid the stricter
    // question is false for our OWN daemon, which switches the feature off entirely.
    if (isForeignOwner(status.uid)) {
      logger.info(
        `:${rung.port} belongs to another user's daemon; trying the next option`,
      );
      return null;
    }
    return {
      mode: rung.mode,
      proxyPort: portFor(rung),
      reason: 'ok',
      started,
      status,
    };
  }
}

/**
 * The port to put in a URL. Wildcard mode is the portless case, which is the
 * entire point of rung 1, so it reports null.
 */
function portFor(rung: { mode: ProxyMode; port: number }): number | null {
  return rung.mode === 'wildcard' ? null : rung.port;
}

function direct(reason: FallbackReason): EnsuredProxy {
  return { mode: 'direct', proxyPort: null, reason, started: false, status: null };
}

/**
 * Spawn the daemon through its own detach hop.
 *
 * The script path is an argv element with `shell: false` (the default), never a
 * command string - that is what makes paths containing spaces
 * (`~/Library/Application Support`) and non-ASCII paths safe on every platform.
 */
function launch(entry: string, port: number, env: NodeJS.ProcessEnv): void {
  const child = spawn(nodeBinary(), [entry, '--detach'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...env, STAGHORN_PORT: String(port) },
  });
  // An 'error' event with no listener is re-thrown by Node in THIS process - the
  // dev server - so a spawn hiccup (EAGAIN/EMFILE, exactly what several dev
  // servers starting at once can produce) would break the very thing this
  // function promises never to break. unref() does not cover it: that only stops
  // the child holding the event loop open.
  child.on('error', () => {
    // Swallowed deliberately: the poll in ensureProxy observes the absence and the
    // ladder degrades with its own message. There is nothing here a developer
    // could act on that the ladder does not already say.
  });
  child.unref();
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}
