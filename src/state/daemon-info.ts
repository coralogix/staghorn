// SPDX-License-Identifier: Apache-2.0
//
// Where the running daemon advertises the address it actually bound.
//
// No client may assume :80. The daemon walks a fallback ladder, so its port is a
// runtime fact - and publishing it here is what makes the alternate-port rung,
// the in-process mode, multi-user machines and Linux CI all work from one code
// path rather than four. It is also what lets every test run the daemon on an
// ephemeral port instead of needing privileges.

import { readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';

import { errorMessage, isEnoent } from '../errors';
import { silentLogger, type Logger } from '../log';
import { daemonInfoPath, stateDir } from '../paths';
import { isPidAlive } from './routes';

export const DAEMON_INFO_SCHEMA_VERSION = 1;

export interface DaemonInfo {
  readonly schemaVersion: number;
  readonly name: string;
  readonly protocol: number;
  /** npm version of the package the daemon was spawned from. */
  readonly version: string;
  readonly pid: number;
  /** The port the daemon is listening on right now. */
  readonly port: number;
  /** Bind address, or null for the wildcard. */
  readonly host: string | null;
  /** Owning OS user. A daemon owned by someone else is never leased or stopped. */
  readonly uid: number | null;
  /** State dir the daemon reads routes from, for diagnosing split state. */
  readonly stateDir: string;
  readonly startedAt: number;
}

export interface DaemonInfoStore {
  read(): Promise<DaemonInfo | null>;
  readSync(): DaemonInfo | null;
  write(info: DaemonInfoInput): Promise<DaemonInfo>;
  clear(): Promise<void>;
  clearSync(): void;
}

export type DaemonInfoInput = Omit<
  DaemonInfo,
  'schemaVersion' | 'startedAt' | 'uid' | 'stateDir'
> &
  Partial<Pick<DaemonInfo, 'uid' | 'stateDir' | 'startedAt'>>;

export interface DaemonInfoStoreOptions {
  readonly path?: () => string;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export function createDaemonInfoStore({
  path = daemonInfoPath,
  now = Date.now,
  logger = silentLogger,
}: DaemonInfoStoreOptions = {}): DaemonInfoStore {
  return {
    read: async () => {
      try {
        return parse(await readFile(path(), 'utf8'), logger);
      } catch (err) {
        if (!isEnoent(err)) {
          logger.debug('could not read daemon info', { error: errorMessage(err) });
        }
        return null;
      }
    },

    readSync: () => {
      try {
        return parse(readFileSync(path(), 'utf8'), logger);
      } catch (err) {
        if (!isEnoent(err)) {
          logger.debug('could not read daemon info', { error: errorMessage(err) });
        }
        return null;
      }
    },

    write: async (input) => {
      const info: DaemonInfo = {
        ...input,
        schemaVersion: DAEMON_INFO_SCHEMA_VERSION,
        uid: input.uid ?? currentUid(),
        stateDir: input.stateDir ?? stateDir(),
        startedAt: input.startedAt ?? now(),
      };
      const target = path();
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
      await rename(tmp, target);
      return info;
    },

    clear: async () => {
      try {
        await rm(path());
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
      }
    },

    clearSync: () => {
      try {
        rmSync(path());
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
      }
    },
  };
}

/**
 * The daemon info only if its process is still running.
 *
 * A daemon killed with SIGKILL never clears its file, so a stale record is the
 * normal case rather than an anomaly. Treating "file exists" as "daemon is up"
 * would make every client wait for a probe timeout against a dead port.
 */
export function liveDaemonInfo(
  store: DaemonInfoStore,
  isAlive: (pid: number) => boolean = isPidAlive,
): Promise<DaemonInfo | null> {
  return store.read().then((info) => (info && isAlive(info.pid) ? info : null));
}

/** True when this daemon is POSITIVELY owned by the current OS user. */
export function isOwnedByCurrentUser(info: DaemonInfo): boolean {
  return isCurrentUid(info.uid);
}

/**
 * True when a uid is positively this process's: both sides known and equal.
 *
 * Use this to CONFIRM ownership. Do not use it to decide whether to leave a daemon
 * alone - see {@link isForeignUid} for why.
 */
export function isCurrentUid(uid: number | null): boolean {
  const mine = currentUid();
  return mine !== null && uid !== null && uid === mine;
}

/**
 * True only when a uid is positively SOMEONE ELSE'S: both sides known and different.
 *
 * This, not `!isCurrentUid`, is the gate for refusing to adopt, lease or stop a
 * daemon. The difference matters because unknown ownership is not evidence of
 * foreign ownership, and Windows has no uid at all - so `!isCurrentUid` is true for
 * every daemon there, including our own.
 *
 * Getting that wrong is not cosmetic. With `!isCurrentUid` as the gate, a Windows
 * developer's second dev server probes the running daemon, sees `ours`, refuses to
 * adopt it, finds the port occupied on every rung, and degrades to direct URLs
 * permanently - the feature silently switches itself off for a whole platform. And
 * it protects nothing there, because a platform with no uid has no uid to steal.
 */
export function isForeignUid(uid: number | null): boolean {
  const mine = currentUid();
  return mine !== null && uid !== null && uid !== mine;
}

function currentUid(): number | null {
  try {
    // Windows has no uid; userInfo() reports -1 there.
    const { uid } = userInfo();
    return typeof uid === 'number' && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

function parse(raw: string, logger: Logger): DaemonInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.debug('ignoring unparseable daemon info');
    return null;
  }
  if (!isDaemonInfo(parsed)) {
    logger.debug('ignoring malformed daemon info');
    return null;
  }
  if (parsed.schemaVersion > DAEMON_INFO_SCHEMA_VERSION) {
    logger.debug('ignoring daemon info from a newer schema', {
      schemaVersion: parsed.schemaVersion,
    });
    return null;
  }
  return parsed;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record['schemaVersion'] === 'number' &&
    typeof record['name'] === 'string' &&
    typeof record['protocol'] === 'number' &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['port'] === 'number' &&
    Number.isInteger(record['port']) &&
    record['port'] > 0 &&
    record['port'] <= 65_535 &&
    (record['host'] === null || typeof record['host'] === 'string') &&
    (record['uid'] === null || typeof record['uid'] === 'number')
  );
}
