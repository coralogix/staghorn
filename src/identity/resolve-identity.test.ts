import { describe, expect, it } from 'vitest';

import { MAX_HOSTNAME_LENGTH } from '../host';
import type { RepoContext } from './context';
import { resolveIdentity } from './resolve-identity';

describe('resolveIdentity branch', () => {
  it('uses the checked-out branch', () => {
    const { branch, branchSource } = resolveIdentity(
      context({ branch: 'feature/Add-Search' }),
    );
    expect(branch).toBe('feature-add-search');
    expect(branchSource).toBe('branch');
  });

  // Bisecting and checking out a tag both detach HEAD, and neither should take the
  // developer's URL away.
  it('falls back to the short sha on a detached HEAD', () => {
    const { branch, branchSource } = resolveIdentity(
      context({ branch: null, sha: 'a1b2c3d' }),
    );
    expect(branch).toBe('a1b2c3d');
    expect(branchSource).toBe('sha');
  });

  it('falls back to this checkout directory', () => {
    const { branch, branchSource } = resolveIdentity(
      context({ branch: null, sha: null, worktreePath: '/repos/feature-x' }),
    );
    expect(branch).toBe('feature-x');
    expect(branchSource).toBe('worktree');
  });

  it('falls back to the cwd outside git', () => {
    const { branch, branchSource } = resolveIdentity(
      context({
        isGit: false,
        branch: null,
        sha: null,
        worktreePath: null,
        mainWorktreePath: null,
        cwd: '/tmp/scratch-app',
      }),
    );
    expect(branch).toBe('scratch-app');
    expect(branchSource).toBe('directory');
  });

  it('honours an explicit branch override', () => {
    expect(resolveIdentity(context({}), { branch: 'Release/2026' }).branch).toBe(
      'release-2026',
    );
  });

  it('applies a caller slug transform', () => {
    const { branch } = resolveIdentity(context({ branch: 'feature/ABC-1/thing' }), {
      slugTransform: (raw) => raw.split('/').slice(-1).join(''),
    });
    expect(branch).toBe('thing');
  });
});

describe('resolveIdentity project', () => {
  it('prefers the nearest package.json name, without the scope', () => {
    const { project, projectSource } = resolveIdentity(
      context({ packageName: '@acme/web-app' }),
    );
    expect(project).toBe('web-app');
    expect(projectSource).toBe('package');
  });

  it('falls back to the origin remote repo name', () => {
    const { project, projectSource } = resolveIdentity(
      context({ packageName: null, remoteName: 'cx-web-workspace' }),
    );
    expect(project).toBe('cx-web-workspace');
    expect(projectSource).toBe('remote');
  });

  // The trap: in a linked worktree the cwd is named after the BRANCH, so deriving
  // the project from it would put the branch in the host twice and make every
  // worktree look like a different project.
  it('derives from the main checkout, not the linked worktree directory', () => {
    const { project, projectSource } = resolveIdentity(
      context({
        packageName: null,
        remoteName: null,
        isLinkedWorktree: true,
        cwd: '/Users/dev/worktrees/feature-add-search',
        worktreePath: '/Users/dev/worktrees/feature-add-search',
        mainWorktreePath: '/Users/dev/code/myapp',
      }),
    );
    expect(project).toBe('myapp');
    expect(projectSource).toBe('repo');
  });

  it('strips the .git suffix from a bare repo directory', () => {
    const { project } = resolveIdentity(
      context({
        packageName: null,
        remoteName: null,
        isBare: true,
        mainWorktreePath: '/srv/repos/myapp.git',
      }),
    );
    expect(project).toBe('myapp');
  });

  it('honours an explicit project override', () => {
    expect(
      resolveIdentity(context({ packageName: '@acme/web-app' }), { project: 'cx' })
        .project,
    ).toBe('cx');
  });

  it('flattens the project label away when set to false', () => {
    const { project, projectSource } = resolveIdentity(context({}), {
      project: false,
    });
    expect(project).toBeNull();
    expect(projectSource).toBeNull();
  });
});

describe('resolveIdentity service', () => {
  it('slugs the service label', () => {
    expect(resolveIdentity(context({}), { service: 'Storybook' }).service).toBe(
      'storybook',
    );
  });

  it('is null by default, keeping single-server hosts one label shorter', () => {
    expect(resolveIdentity(context({})).service).toBeNull();
  });
});

describe('resolveIdentity length budget', () => {
  it('keeps the assembled hostname inside the RFC ceiling', () => {
    const identity = resolveIdentity(
      context({ branch: 'b'.repeat(300), packageName: 'p'.repeat(60) }),
      { service: 'storybook', prefix: 'x'.repeat(60), tld: 'localtest.me' },
    );
    const hostname = [
      'x'.repeat(60),
      identity.service,
      identity.branch,
      identity.project,
      'localtest.me',
    ].join('.');
    expect(hostname.length).toBeLessThanOrEqual(MAX_HOSTNAME_LENGTH);
  });
});

function context(overrides: Partial<RepoContext>): RepoContext {
  return {
    cwd: '/Users/dev/code/myapp',
    isGit: true,
    isLinkedWorktree: false,
    isBare: false,
    worktreePath: '/Users/dev/code/myapp',
    mainWorktreePath: '/Users/dev/code/myapp',
    gitDir: '/Users/dev/code/myapp/.git',
    commonDir: '/Users/dev/code/myapp/.git',
    branch: 'main',
    sha: 'abc1234',
    packageName: 'myapp',
    remoteName: 'myapp',
    platform: 'darwin',
    ...overrides,
  };
}
