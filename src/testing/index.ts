// SPDX-License-Identifier: Apache-2.0
//
// Test helpers, shipped as `staghorn/testing`.
//
// Published rather than kept private because consumers writing their own adapters
// need exactly these: an isolated state dir, a real git fixture, and a fake clock.
// Without them the only way to test an adapter is to let it write to the
// developer's real ~/.staghorn, which is how test suites start deleting each
// other's routes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { createFakeClock, type FakeClock } from '../clock';
export { createRecordingLogger } from '../log';

export interface TempState {
  readonly dir: string;
  readonly routesDir: string;
  /** Environment that points staghorn at this directory. */
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

/**
 * An isolated state directory.
 *
 * Returns the env rather than mutating `process.env`: a mutated environment leaks
 * between tests, and under a forked pool it leaks in ways that depend on which test
 * ran first.
 */
export function createTempState(): TempState {
  const dir = mkdtempSync(join(tmpdir(), 'staghorn-state-'));
  const routes = join(dir, 'routes');
  mkdirSync(routes, { recursive: true });
  return {
    dir,
    routesDir: routes,
    env: { STAGHORN_STATE_DIR: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface GitFixture {
  readonly root: string;
  /** Path of a linked worktree, by branch name. */
  readonly worktrees: ReadonlyMap<string, string>;
  addWorktree(branch: string): string;
  detachHead(): void;
  cleanup(): void;
}

export interface GitFixtureOptions {
  readonly packageName?: string;
  readonly branch?: string;
  readonly worktrees?: readonly string[];
}

/**
 * A real git repository, with real linked worktrees.
 *
 * Real git, not a mock. The identity layer exists to answer questions about
 * detached HEADs, linked worktrees and bare repos, and a mock of git would only
 * ever confirm what the author already believed about it.
 */
export function createGitFixture({
  packageName = 'fixture-app',
  branch = 'main',
  worktrees = [],
}: GitFixtureOptions = {}): GitFixture {
  const base = mkdtempSync(join(tmpdir(), 'staghorn-git-'));
  const root = join(base, packageName);
  mkdirSync(root, { recursive: true });

  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'staghorn',
        GIT_AUTHOR_EMAIL: 'staghorn@example.invalid',
        GIT_COMMITTER_NAME: 'staghorn',
        GIT_COMMITTER_EMAIL: 'staghorn@example.invalid',
      },
    }).trim();

  git('init', '-q', '-b', branch);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: packageName, private: true }, null, 2)}\n`,
    'utf8',
  );
  git('add', '-A');
  // No signing and no hooks: a contributor's global git config must not be able to
  // change what this fixture produces.
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

  const created = new Map<string, string>();
  const addWorktree = (name: string): string => {
    const path = join(base, name.replace(/[^\w.-]+/g, '-'));
    git('worktree', 'add', '-q', '-b', name, path);
    created.set(name, path);
    return path;
  };
  for (const name of worktrees) {
    addWorktree(name);
  }

  return {
    root,
    worktrees: created,
    addWorktree,
    detachHead: () => git('checkout', '-q', '--detach', 'HEAD'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface FakeUpstream {
  readonly port: number;
  readonly requests: ReadonlyArray<{ method: string; url: string }>;
  close(): Promise<void>;
}

/** A minimal HTTP server standing in for a dev server. */
export async function createFakeUpstream(body = 'ok'): Promise<FakeUpstream> {
  const { createServer } = await import('node:http');
  const requests: Array<{ method: string; url: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
