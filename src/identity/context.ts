// Working out what this checkout IS: which project, which branch, whether it is a
// linked worktree, and whether it is a git repo at all.
//
// The predecessor only ever answered "am I in a linked worktree", because that was
// the only case it served. A package anyone can install has to work in a plain
// clone, on a detached HEAD, in a bare repo and outside git entirely - each of
// which still deserves a stable named URL.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { isEnoent } from '../errors';

export interface RepoContext {
  readonly cwd: string;
  readonly isGit: boolean;
  /** A `git worktree add` checkout rather than the main one. */
  readonly isLinkedWorktree: boolean;
  readonly isBare: boolean;
  /** Top level of THIS checkout. */
  readonly worktreePath: string | null;
  /**
   * Top level of the MAIN checkout - the one every linked worktree shares.
   *
   * This is what a project name must be derived from. In a linked worktree
   * `basename(cwd)` is the branch's directory, so the obvious implementation
   * yields the branch name twice and every worktree of one project looks like a
   * different project.
   */
  readonly mainWorktreePath: string | null;
  readonly gitDir: string | null;
  readonly commonDir: string | null;
  /** null on a detached HEAD. */
  readonly branch: string | null;
  readonly sha: string | null;
  /** Nearest package.json `name`, scope included. */
  readonly packageName: string | null;
  /** Repository name from the origin remote, if there is one. */
  readonly remoteName: string | null;
  readonly platform: NodeJS.Platform;
}

export interface RepoContextDeps {
  readonly runGit?: (args: readonly string[], cwd: string) => Promise<string | null>;
  readonly readPackageName?: (cwd: string) => Promise<string | null>;
  readonly platform?: NodeJS.Platform;
}

const GIT_TIMEOUT_MS = 3_000;

export async function readRepoContext(
  cwd: string = process.cwd(),
  deps: RepoContextDeps = {},
): Promise<RepoContext> {
  const {
    runGit = defaultRunGit,
    readPackageName = nearestPackageName,
    platform = process.platform,
  } = deps;

  // One round of git in parallel. Each returns null rather than throwing when the
  // directory is not a repo, so "not git" needs no special-casing.
  const [gitDirRaw, commonDirRaw, bare, topLevel, branchRaw, sha, remoteUrl, packageName] =
    await Promise.all([
      runGit(['rev-parse', '--absolute-git-dir'], cwd),
      runGit(['rev-parse', '--git-common-dir'], cwd),
      runGit(['rev-parse', '--is-bare-repository'], cwd),
      runGit(['rev-parse', '--show-toplevel'], cwd),
      // `symbolic-ref --short HEAD`, not `rev-parse --abbrev-ref HEAD`. The latter
      // needs a commit to exist, so on a freshly initialised repo - or any branch
      // before its first commit - it fails and the branch name is lost even though
      // git knows it perfectly well. symbolic-ref reads the ref itself, and still
      // fails on a detached HEAD, which is exactly when the sha should be used.
      runGit(['symbolic-ref', '--short', 'HEAD'], cwd),
      runGit(['rev-parse', '--short', 'HEAD'], cwd),
      runGit(['remote', 'get-url', 'origin'], cwd),
      readPackageName(cwd),
    ]);

  const isGit = gitDirRaw !== null;
  const gitDir = gitDirRaw;
  // --git-common-dir can come back RELATIVE to cwd (plain `.git` in the main
  // checkout), so it has to be resolved before it can be compared or walked up.
  const commonDir =
    commonDirRaw === null
      ? null
      : isAbsolute(commonDirRaw)
        ? commonDirRaw
        : resolve(cwd, commonDirRaw);

  return {
    cwd,
    isGit,
    // A linked worktree has its own git dir under the shared common dir; the main
    // checkout has them equal.
    isLinkedWorktree:
      gitDir !== null && commonDir !== null && resolve(gitDir) !== resolve(commonDir),
    isBare: bare === 'true',
    worktreePath: topLevel,
    mainWorktreePath: mainWorktreeFrom(commonDir),
    gitDir,
    commonDir,
    // symbolic-ref fails outright on a detached HEAD, so null already means
    // "detached" - no need to filter a literal "HEAD" the way abbrev-ref required.
    branch: branchRaw,
    sha,
    packageName,
    remoteName: repoNameFromRemote(remoteUrl),
    platform,
  };
}

/**
 * The main checkout, from the common git dir.
 *
 * Normally the common dir is `<main>/.git`, so the parent is the checkout. A bare
 * repo's common dir IS the repo, and conventionally ends in `.git`.
 */
function mainWorktreeFrom(commonDir: string | null): string | null {
  if (commonDir === null) {
    return null;
  }
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

/** `git@host:org/repo.git` and `https://host/org/repo.git` both give `repo`. */
function repoNameFromRemote(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const withoutSuffix = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const lastSegment = withoutSuffix.split(/[/:]/).pop();
  return lastSegment ? lastSegment : null;
}

/**
 * Nearest package.json `name`, walking up from cwd.
 *
 * Stops at the filesystem root rather than at the repo root on purpose: this also
 * has to work outside git, which is one of the cases a public consumer will be in.
 */
export async function nearestPackageName(cwd: string): Promise<string | null> {
  const { root } = parse(resolve(cwd));
  let directory = resolve(cwd);
  for (;;) {
    const name = await packageNameIn(directory);
    if (name !== null) {
      return name;
    }
    if (directory === root) {
      return null;
    }
    directory = dirname(directory);
  }
}

async function packageNameIn(directory: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(directory, 'package.json'), 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    // An unreadable package.json is not a reason to fail identity resolution;
    // there are three more sources after this one.
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'name' in parsed &&
      typeof parsed.name === 'string' &&
      parsed.name.length > 0
    ) {
      return parsed.name;
    }
  } catch {
    // A malformed package.json is the consumer's problem, not ours to report.
  }
  return null;
}

function defaultRunGit(
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve_) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // Never let a repo-local hook or pager interfere with a machine-read value.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
      },
      (err, stdout) => {
        // Not a repo, git missing, or the command not applicable - all "no answer"
        // rather than a failure, because every one of them is a supported state.
        resolve_(err ? null : stdout.trim() || null);
      },
    );
  });
}
