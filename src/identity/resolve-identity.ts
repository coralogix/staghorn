// SPDX-License-Identifier: Apache-2.0
//
// Turning a RepoContext into the two labels that make a host: branch and project.
//
// Every step has a fallback, and the last one always succeeds. A consumer who is
// not in git, or is on a detached HEAD, or has no package.json, still gets a stable
// named URL - that is the difference between a tool for one monorepo and a tool
// anyone can install.

import { branchLabelBudget, branchToLabel, projectToLabel } from './slug';
import type { RepoContext } from './context';
import { basename } from 'node:path';

/** How the branch label is derived. */
export type BranchSource = 'branch' | 'sha' | 'worktree' | 'directory';

/** How the project label is derived. */
export type ProjectSource = 'config' | 'package' | 'remote' | 'repo' | 'directory';

export interface ResolvedIdentity {
  readonly branch: string;
  readonly branchSource: BranchSource;
  readonly project: string | null;
  readonly projectSource: ProjectSource | null;
  readonly service: string | null;
}

export interface IdentityOverrides {
  /** Explicit project label. `false` flattens the label away entirely. */
  readonly project?: string | false | null;
  /** Explicit branch label, before slugging. */
  readonly branch?: string | null;
  readonly service?: string | null;
  /** Applied after the default flattening. */
  readonly slugTransform?: (raw: string, context: RepoContext) => string;
  readonly tld?: string;
  /** Longest prefix the app will put in front of the route key, for the budget. */
  readonly prefix?: string | null;
}

export function resolveIdentity(
  context: RepoContext,
  overrides: IdentityOverrides = {},
): ResolvedIdentity {
  const { tld = 'localhost', prefix = null, service = null } = overrides;

  const project = resolveProject(context, overrides.project);
  const budget = branchLabelBudget({
    service,
    project: project?.label ?? null,
    tld,
    prefix,
  });

  const branch = resolveBranch(context, overrides.branch);
  const transformed = overrides.slugTransform
    ? overrides.slugTransform(branch.raw, context)
    : branch.raw;

  return {
    branch: branchToLabel(transformed, budget),
    branchSource: branch.source,
    project: project?.label ?? null,
    projectSource: project?.source ?? null,
    service: service === null ? null : projectToLabel(service),
  };
}

/**
 * Branch label, in order: the checked-out branch, the short sha on a detached
 * HEAD, this checkout's directory, then the cwd.
 *
 * The sha step matters more than it looks - bisecting, or checking out a tag, both
 * detach HEAD, and neither should take the developer's URL away.
 */
function resolveBranch(
  context: RepoContext,
  override: string | null | undefined,
): { raw: string; source: BranchSource } {
  if (override) {
    return { raw: override, source: 'branch' };
  }
  if (context.branch) {
    return { raw: context.branch, source: 'branch' };
  }
  if (context.sha) {
    return { raw: context.sha, source: 'sha' };
  }
  if (context.worktreePath) {
    return { raw: basename(context.worktreePath), source: 'worktree' };
  }
  return { raw: basename(context.cwd) || 'dev', source: 'directory' };
}

/**
 * Project label, in order: explicit config, nearest package.json name, the origin
 * remote's repo name, the MAIN checkout's directory, then the cwd.
 *
 * The main checkout - not `basename(cwd)`. In a linked worktree the cwd is named
 * after the branch, so deriving the project from it would put the branch in the
 * host twice and make every worktree of one project look like a separate project,
 * defeating the label's whole purpose.
 */
function resolveProject(
  context: RepoContext,
  override: string | false | null | undefined,
): { label: string; source: ProjectSource } | null {
  if (override === false) {
    return null;
  }
  if (override) {
    return { label: projectToLabel(override), source: 'config' };
  }
  if (context.packageName) {
    return { label: projectToLabel(context.packageName), source: 'package' };
  }
  if (context.remoteName) {
    return { label: projectToLabel(context.remoteName), source: 'remote' };
  }
  if (context.mainWorktreePath) {
    // A bare repo's directory conventionally ends in .git; that is not part of the
    // project's name.
    const name = basename(context.mainWorktreePath).replace(/\.git$/, '');
    if (name) {
      return { label: projectToLabel(name), source: 'repo' };
    }
  }
  const fromCwd = basename(context.cwd);
  return fromCwd
    ? { label: projectToLabel(fromCwd), source: 'directory' }
    : null;
}
