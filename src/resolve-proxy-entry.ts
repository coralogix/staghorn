// SPDX-License-Identifier: Apache-2.0
//
// Finding our own daemon file, across every way this package can be installed.
//
// This is the highest-risk mechanical detail in the package. The version this grew
// out of hardcoded absolute paths to a TypeScript runner and to its own daemon
// source, both relative to a fixed directory layout - which works exactly once, in
// the one repository it shipped in. A published package has to locate a file it owns
// while knowing nothing about the consumer's layout, package manager, or hoisting.
//
// Resolution order, first hit wins:
//
//   1. STAGHORN_PROXY_ENTRY   explicit override; fails loudly if unusable
//   2. an explicit option        callers that already know (e.g. a monorepo)
//   3. sibling of this module    the primary path
//   4. createRequire.resolve     recovery when a consumer bundled us
//   5. materialize (copy out)    readable but not spawnable
//
// Why the SIBLING is primary and require.resolve is only recovery: require.resolve
// finds the NEAREST installed copy, which under pnpm's isolated layout can be a
// different version than the code currently executing. That would pair a library
// with a daemon from another release - silent, and awful to debug. The sibling
// path cannot skew, because the daemon is always adjacent to the running module.
//
// Why `import.meta.resolve` is not used at all: absent from the CJS output,
// sync-vs-Promise behaviour varied across Node 18 and early 20, bundlers rewrite
// or reject it, and under Yarn PnP it returns the same unspawnable zip URL as
// everything else. It buys nothing over the sibling path and adds three caveats.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage } from './errors';
import { silentLogger, type Logger } from './log';
import { relocatedDaemonDir } from './paths';
import { PACKAGE_NAME, VERSION } from './version';

/** Filename of the bundled daemon inside `dist/`. */
export const DAEMON_FILENAME = 'proxy.mjs';

/**
 * Subpath the recovery step resolves. Must stay in the package `exports` map.
 *
 * Built from the package's own injected name, not written down: this package is
 * published to the internal registry first and renamed on the way to public, and
 * a stale literal here would not throw - it would just make step 4 never match,
 * degrading silently to the materialize path or to no daemon at all.
 */
export const DAEMON_SPECIFIER = `${PACKAGE_NAME}/proxy`;

export const PROXY_ENTRY_ENV = 'STAGHORN_PROXY_ENTRY';

export interface ProxyEntryDeps {
  /** Directory of the running module. Injected so tests can stage layouts. */
  readonly selfDir?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requireResolve?: (specifier: string) => string | null;
  readonly exists?: (path: string) => boolean;
  readonly readText?: (path: string) => string;
  readonly writeText?: (path: string, text: string) => void;
  readonly mkdirp?: (path: string) => void;
  readonly rename?: (from: string, to: string) => void;
  /** Bases tried by the materialize step, in order. */
  readonly relocateBases?: () => readonly string[];
  readonly logger?: Logger;
  readonly version?: string;
}

export interface ProxyEntryResolver {
  /** The daemon path, or null when nothing usable was found. */
  resolve(explicit?: string | null): string | null;
  /** Forget the memoised answer. */
  reset(): void;
}

export function createProxyEntryResolver(
  deps: ProxyEntryDeps = {},
): ProxyEntryResolver {
  const {
    selfDir = defaultSelfDir,
    env = process.env,
    requireResolve = defaultRequireResolve,
    exists = defaultExists,
    readText = (path) => readFileSync(path, 'utf8'),
    writeText = (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    mkdirp = (path) => void mkdirSync(path, { recursive: true }),
    rename = renameSync,
    relocateBases = defaultRelocateBases,
    logger = silentLogger,
    version = VERSION,
  } = deps;

  let cached: string | null | undefined;

  const spawnable = (path: string): boolean => exists(path) && !isZipMounted(path);

  const materialize = (source: string): string | null => {
    let text: string;
    try {
      // Yarn PnP patches `fs`, so this succeeds even inside a zip - which is the
      // entire reason this step can work at all.
      text = readText(source);
    } catch (err) {
      logger.debug('could not read the daemon for relocation', {
        source,
        error: errorMessage(err),
      });
      return null;
    }
    // Content hash plus version in the name: no staleness, and two versions can
    // coexist without either overwriting the other.
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const name = `proxy-${version}-${hash}.mjs`;
    for (const base of relocateBases()) {
      try {
        mkdirp(base);
        const target = join(base, name);
        if (exists(target)) {
          return target;
        }
        // tmp + rename so two dev servers starting together cannot observe or
        // produce a half-written file.
        const tmp = `${target}.tmp-${process.pid}`;
        writeText(tmp, text);
        rename(tmp, target);
        logger.debug('relocated the daemon so it can be spawned', { target });
        return target;
      } catch (err) {
        // A read-only $HOME (containers, some CI images) is the expected reason
        // to fall through to the next base.
        logger.debug('could not relocate the daemon here', {
          base,
          error: errorMessage(err),
        });
      }
    }
    return null;
  };

  const locate = (explicit?: string | null): string | null => {
    const override = env[PROXY_ENTRY_ENV]?.trim();
    if (override) {
      if (!spawnable(override)) {
        // The one loud failure in this module. An override that silently did
        // nothing would be worse than no override at all.
        throw new Error(
          `${PROXY_ENTRY_ENV}=${override} is not a file this process can spawn`,
        );
      }
      return override;
    }
    if (explicit && spawnable(explicit)) {
      return explicit;
    }

    const sibling = join(selfDir(), DAEMON_FILENAME);
    if (spawnable(sibling)) {
      return sibling;
    }

    const resolved = requireResolve(DAEMON_SPECIFIER);
    if (resolved && spawnable(resolved)) {
      return resolved;
    }

    // Readable but not spawnable: Yarn PnP zips, and any exotic FUSE mount with
    // the same property.
    for (const candidate of [sibling, resolved]) {
      if (candidate && exists(candidate)) {
        const relocated = materialize(candidate);
        if (relocated) {
          return relocated;
        }
      }
    }

    logger.warn(
      `could not locate the staghorn daemon; set ${PROXY_ENTRY_ENV} to its path, ` +
        'or mark this package external if you bundle your dev script',
    );
    return null;
  };

  return {
    resolve: (explicit) => {
      // An explicit argument bypasses the memo - a caller passing a path means it.
      if (explicit) {
        return locate(explicit);
      }
      if (cached === undefined) {
        cached = locate();
      }
      return cached;
    },
    reset: () => {
      cached = undefined;
    },
  };
}

/** The default resolver, memoised for the process. */
export const proxyEntryResolver: ProxyEntryResolver = createProxyEntryResolver({
  logger: silentLogger,
});

/**
 * True when a path lives inside a zip-mounted dependency.
 *
 * Yarn PnP patches `fs` but not `child_process`/execve, so such a file can be
 * read and cannot be executed. That asymmetry is exactly why the materialize step
 * exists, and this is how it is detected - a heuristic, but a load-bearing and
 * documented one, verified for real by the yarn-pnp fixture in the install matrix.
 */
export function isZipMounted(path: string): boolean {
  return /\.zip[/\\]/.test(path);
}

/** True when Yarn PnP is the active resolver. Diagnostics only. */
export function isPnpActive(): boolean {
  return typeof process.versions.pnp === 'string';
}

/**
 * Choose the node binary to spawn the daemon with.
 *
 * `process.execPath` is not always node: under Bun or Deno it is that runtime,
 * and the lease protocol depends on Node's socket semantics. Prefer a real node
 * and fall back rather than fail.
 */
export function nodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
): string {
  if (versions.bun === undefined && versions.deno === undefined) {
    return process.execPath;
  }
  return which('node', env) ?? process.execPath;
}

function which(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathList = env['PATH'] ?? env['Path'] ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions =
    process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of pathList.split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (defaultExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function defaultSelfDir(): string {
  // In the CJS output tsup's shims turn import.meta.url into a __filename-based
  // equivalent, so both formats land on the same realpath - asserted in the tests.
  return dirname(fileURLToPath(import.meta.url));
}

function defaultRequireResolve(specifier: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    // Not installed under that name (source checkout, renamed fork, PnP strictness).
    return null;
  }
}

function defaultExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

// State dir first so the relocated daemon survives a tmp sweep; tmpdir second for
// the read-only-$HOME case.
function defaultRelocateBases(): readonly string[] {
  return [relocatedDaemonDir(), join(tmpdir(), 'staghorn-bin')];
}
