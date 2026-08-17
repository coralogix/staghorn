// The route registry: which dev server owns which host, and on what port.
//
// One file per route, not one shared registry.json. The single-file design had a
// race it could only document, not fix: two dev servers starting together both
// read, both mutate, and the second write drops the first one's route. Splitting
// the directory removes the race rather than guarding it, because writers never
// touch each other's files. A lock would have been worse than the bug - any lock
// this process could take is a lock a SIGKILL can leave behind forever.

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isEnoent } from '../errors';
import { silentLogger, type Logger } from '../log';
import { decodeRouteKey, encodeRouteKey, routesDir } from '../paths';

/** Bumped when the on-disk shape of a route file changes. */
export const ROUTE_SCHEMA_VERSION = 1;

/** One dev server, as recorded on disk. */
export interface DevRoute {
  readonly schemaVersion: number;
  /** Dotted host suffix beneath the tld: `storybook.feature-x.myapp`. */
  readonly routeKey: string;
  readonly port: number;
  /** The dev server process. Its liveness is what makes a route real. */
  readonly pid: number;
  /** Checkout the dev server was started from. Identifies re-serves of the same tree. */
  readonly checkoutPath: string;
  readonly branch: string | null;
  readonly project: string | null;
  readonly service: string | null;
  readonly createdAt: number;
  /** Consumer-supplied labels, surfaced by `devd list --json`. */
  readonly meta?: Readonly<Record<string, string>>;
}

/** An immutable view of the registry at one instant. */
export interface RouteSnapshot {
  readonly routes: ReadonlyMap<string, DevRoute>;
  readonly size: number;
  has(routeKey: string): boolean;
  get(routeKey: string): DevRoute | undefined;
}

export interface PruneResult {
  readonly removed: readonly string[];
  readonly kept: number;
}

export interface RouteStore {
  read(): Promise<RouteSnapshot>;
  readSync(): RouteSnapshot;
  upsert(route: RouteInput): Promise<DevRoute>;
  /**
   * Remove a route. When `ownerPid` is given the removal only happens if that pid
   * still owns the file, so a dying serve can never delete the route a newer
   * serve just claimed for the same host.
   */
  remove(routeKey: string, ownerPid?: number): Promise<boolean>;
  removeSync(routeKey: string, ownerPid?: number): boolean;
  prune(): Promise<PruneResult>;
  /** Watch for any change. Returns an unsubscribe function. */
  watch(onChange: () => void): () => void;
}

export type RouteInput = Omit<DevRoute, 'schemaVersion' | 'createdAt'> &
  Partial<Pick<DevRoute, 'createdAt'>>;

export interface RouteStoreOptions {
  /** Resolved per call, so a test can move the state dir without reloading modules. */
  readonly dir?: () => string;
  /** Liveness check. Injected so container and remote topologies can redefine it. */
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** Coalescing window for `watch`. */
  readonly watchDebounceMs?: number;
  /** 'poll' (default) or 'off'. See the note on {@link WatchStrategy}. */
  readonly watchStrategy?: WatchStrategy;
  readonly watchPollIntervalMs?: number;
}

/**
 * Changes are noticed by POLLING. `fs.watch` is deliberately not used at all.
 *
 * It was tried, on both of the obvious paths, and it fails differently on each
 * platform:
 *
 *   - Windows: libuv's fs-event backend asserts and ABORTS THE PROCESS when the
 *     filename it is handed does not share the watched directory's prefix
 *     (`!_wcsnicmp(filename, dir, dirlen)`, src/win/fs-event.c). An 8.3 short path is
 *     enough, and Windows temp directories routinely have one. It is not catchable.
 *   - macOS: watching a directory reached through a symlink - which `os.tmpdir()`
 *     is, `/var` -> `/private/var` - delivers events unreliably.
 *
 * A shared daemon must not be abortable by a filesystem event, and a change signal
 * that works on one platform is not a change signal. Polling is one code path, has no
 * platform branch, and is deterministic to test.
 *
 * The cost is bounded and small: at worst `watchPollIntervalMs` of extra latency
 * before a new route is picked up. The watch was only ever an optimisation - the
 * daemon re-reads its routing table on staleness anyway, and that TTL is the same
 * order of magnitude - so nothing is actually lost.
 */
export type WatchStrategy = 'poll' | 'off';

const DEFAULT_WATCH_DEBOUNCE_MS = 40;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 250;

export function createFileRouteStore({
  dir = routesDir,
  isAlive = isPidAlive,
  now = Date.now,
  logger = silentLogger,
  watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  watchStrategy = 'poll',
  watchPollIntervalMs = DEFAULT_WATCH_POLL_INTERVAL_MS,
}: RouteStoreOptions = {}): RouteStore {
  return {
    read: async () => snapshot(await readAllAsync(dir(), logger)),
    readSync: () => snapshot(readAllSync(dir(), logger)),

    upsert: async (input) => {
      const route: DevRoute = {
        ...input,
        schemaVersion: ROUTE_SCHEMA_VERSION,
        createdAt: input.createdAt ?? now(),
      };
      const directory = dir();
      await mkdir(directory, { recursive: true });
      const target = join(directory, `${encodeRouteKey(route.routeKey)}.json`);
      // Write to a pid-suffixed temp then rename. rename(2) is atomic within a
      // filesystem, so a reader never observes a half-written file and two
      // concurrent writers of the SAME key cannot interleave bytes.
      const tmp = `${target}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(route, null, 2)}\n`, 'utf8');
      await rename(tmp, target);
      logger.debug('route registered', { routeKey: route.routeKey, port: route.port });
      return route;
    },

    remove: async (routeKey, ownerPid) => {
      const target = join(dir(), `${encodeRouteKey(routeKey)}.json`);
      if (ownerPid !== undefined) {
        const existing = await readRouteAsync(target, logger);
        if (existing && existing.pid !== ownerPid) {
          logger.debug('route not removed: owned by another process', {
            routeKey,
            ownerPid,
            actual: existing.pid,
          });
          return false;
        }
      }
      try {
        await rm(target);
        return true;
      } catch (err) {
        if (isEnoent(err)) {
          return false;
        }
        throw err;
      }
    },

    // Sync twin exists for exactly one caller: process exit handlers, which
    // cannot await. Nothing else should use it.
    removeSync: (routeKey, ownerPid) => {
      const target = join(dir(), `${encodeRouteKey(routeKey)}.json`);
      if (ownerPid !== undefined) {
        const existing = readRouteSync(target, logger);
        if (existing && existing.pid !== ownerPid) {
          return false;
        }
      }
      try {
        rmSync(target);
        return true;
      } catch (err) {
        if (isEnoent(err)) {
          return false;
        }
        throw err;
      }
    },

    prune: async () => {
      const directory = dir();
      const entries = await readEntriesAsync(directory, logger);
      const removed: string[] = [];
      let kept = 0;
      for (const { file, route } of entries) {
        if (route && isAlive(route.pid)) {
          kept++;
          continue;
        }
        try {
          await rm(join(directory, file));
          if (route) {
            removed.push(route.routeKey);
          }
        } catch (err) {
          if (!isEnoent(err)) {
            logger.warn('could not prune route file', { file, error: errorMessage(err) });
          }
        }
      }
      return { removed, kept };
    },

    watch: (onChange) => {
      if (watchStrategy === 'off') {
        return () => {};
      }
      const directory = dir();
      try {
        mkdirSync(directory, { recursive: true });
      } catch (err) {
        logger.warn('could not create state dir for watching', { error: errorMessage(err) });
        return () => {};
      }

      let debounce: NodeJS.Timeout | null = null;
      const fire = (): void => {
        // Coalesce: an atomic write is a create plus a rename, and a prune of N
        // routes is N unlinks. Without this the daemon reloads its table several
        // times for one logical change.
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          debounce = null;
          onChange();
        }, watchDebounceMs);
        debounce.unref?.();
      };
      const clearDebounce = (): void => {
        if (debounce) {
          clearTimeout(debounce);
          debounce = null;
        }
      };

      let previous = directoryFingerprint(directory);
      const poller = setInterval(() => {
        const current = directoryFingerprint(directory);
        if (current !== previous) {
          previous = current;
          fire();
        }
      }, watchPollIntervalMs);
      poller.unref?.();
      return () => {
        clearInterval(poller);
        clearDebounce();
      };
    },
  };
}

/**
 * A fingerprint of the directory's route files, or '' when it cannot be read.
 *
 * The entry LIST, not the directory mtime. Directory mtime is the obvious signal and
 * it does not work: NTFS does not reliably bump a directory's last-write-time when a
 * child is created, so on the very platform this polling path exists to serve, the
 * poll would never fire. Listing the directory answers the question directly -
 * "which routes exist" - instead of relying on a filesystem's metadata bookkeeping.
 *
 * Cheap enough to run on a timer: the directory holds one small file per running dev
 * server, so this is a readdir over a handful of entries.
 */
function directoryFingerprint(directory: string): string {
  try {
    // JSON rather than a joined string. A separator has to be a character that can
    // never appear in a filename, and choosing one invites exactly the mistake this
    // line already made once - it shipped with a literal NUL byte as the separator,
    // which made the whole source file read as binary to grep and diff.
    // JSON.stringify is unambiguous by construction and is printable ASCII only.
    return JSON.stringify(readdirSync(directory).filter(isRouteFile).sort());
  } catch {
    return '';
  }
}

/**
 * Whether a pid is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to another user - alive
 * for our purposes, and notably the case on a shared machine, where treating it
 * as dead would let one developer prune another's routes.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorIsEperm(err);
  }
}

// A Map keyed by string has no prototype to pollute, so a route named
// `__proto__` or `constructor` is just a key. The single-file design used a plain
// object and needed Object.create(null) plus Object.hasOwn guards at every access
// to get the same property; this removes the class of bug instead of guarding it.
function snapshot(routes: Map<string, DevRoute>): RouteSnapshot {
  return {
    routes,
    size: routes.size,
    has: (routeKey) => routes.has(routeKey),
    get: (routeKey) => routes.get(routeKey),
  };
}

async function readAllAsync(directory: string, logger: Logger): Promise<Map<string, DevRoute>> {
  const entries = await readEntriesAsync(directory, logger);
  return collect(entries);
}

function readAllSync(directory: string, logger: Logger): Map<string, DevRoute> {
  let files: string[];
  try {
    files = readdirSync(directory).filter(isRouteFile);
  } catch (err) {
    if (isEnoent(err)) {
      return new Map();
    }
    throw err;
  }
  return collect(
    files.map((file) => ({
      file,
      route: readRouteSync(join(directory, file), logger),
    })),
  );
}

async function readEntriesAsync(
  directory: string,
  logger: Logger,
): Promise<Array<{ file: string; route: DevRoute | null }>> {
  let files: string[];
  try {
    files = (await readdir(directory)).filter(isRouteFile);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  return Promise.all(
    files.map(async (file) => ({
      file,
      route: await readRouteAsync(join(directory, file), logger),
    })),
  );
}

function collect(
  entries: Array<{ file: string; route: DevRoute | null }>,
): Map<string, DevRoute> {
  return entries.reduce((routes, { file, route }) => {
    if (!route) {
      return routes;
    }
    // The filename is authoritative for the key; a file whose contents disagree
    // is corrupt and skipped rather than trusted.
    if (route.routeKey !== decodeRouteKey(file)) {
      return routes;
    }
    routes.set(route.routeKey, route);
    return routes;
  }, new Map<string, DevRoute>());
}

async function readRouteAsync(path: string, logger: Logger): Promise<DevRoute | null> {
  try {
    return parseRoute(await readFile(path, 'utf8'), path, logger);
  } catch (err) {
    // ENOENT is routine: a prune elsewhere can delete a file between the
    // readdir and the read. Anything else is worth a line.
    if (!isEnoent(err)) {
      logger.warn('could not read route file', { path, error: errorMessage(err) });
    }
    return null;
  }
}

function readRouteSync(path: string, logger: Logger): DevRoute | null {
  try {
    return parseRoute(readFileSync(path, 'utf8'), path, logger);
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn('could not read route file', { path, error: errorMessage(err) });
    }
    return null;
  }
}

function parseRoute(raw: string, path: string, logger: Logger): DevRoute | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.debug('ignoring unparseable route file', { path });
    return null;
  }
  if (!isDevRoute(parsed)) {
    logger.debug('ignoring malformed route file', { path });
    return null;
  }
  // A file written by a NEWER version is left completely alone: skipped for
  // routing, never rewritten, never pruned by us. An old client must not be able
  // to corrupt a new client's state just by running.
  if (parsed.schemaVersion > ROUTE_SCHEMA_VERSION) {
    logger.debug('ignoring route file from a newer schema', {
      path,
      schemaVersion: parsed.schemaVersion,
    });
    return null;
  }
  return parsed;
}

/** Per-field guard - the state dir is shared and hand-editable, so nothing is asserted. */
function isDevRoute(value: unknown): value is DevRoute {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record['schemaVersion'] === 'number' &&
    typeof record['routeKey'] === 'string' &&
    record['routeKey'].length > 0 &&
    isUsablePort(record['port']) &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['checkoutPath'] === 'string' &&
    isNullableString(record['branch']) &&
    isNullableString(record['project']) &&
    isNullableString(record['service']) &&
    typeof record['createdAt'] === 'number'
  );
}

function isUsablePort(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65_535
  );
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isRouteFile(file: string): boolean {
  return file.endsWith('.json') && !file.includes('.tmp-');
}

function errorIsEperm(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'EPERM'
  );
}
