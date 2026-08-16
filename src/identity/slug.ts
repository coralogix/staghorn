// Turning human names (branches, project names) into legal DNS labels, and
// resolving the rare collision. Pure - no IO, no state.

import {
  MAX_HOSTNAME_LENGTH,
  MAX_LABEL_LENGTH,
  buildRouteKey,
  type RouteParts,
} from '../host';

/**
 * Flatten an arbitrary name into a legal DNS label: lowercase, every run of
 * illegal characters collapsed to a single '-', edges trimmed, length capped.
 *
 * The whole name is preserved rather than re-derived into something shorter -
 * `feature/Add-Search` becomes `feature-add-search`, not `feature`. A developer
 * should be able to read their branch back out of the URL.
 */
export function slugLabel(raw: string, maxLength = MAX_LABEL_LENGTH): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, Math.max(1, Math.min(maxLength, MAX_LABEL_LENGTH)))
    .replace(/-+$/, '');
}

/** The branch label. Empty branches (detached HEAD) are the caller's problem. */
export function branchToLabel(branch: string, maxLength?: number): string {
  return slugLabel(branch, maxLength);
}

/**
 * The project label. `@scope/app` keeps only `app`: the scope is noise in a URL,
 * and two projects that differ only by scope are vanishingly rare next to the
 * cost of every URL carrying `-scope-` forever.
 */
export function projectToLabel(name: string, maxLength?: number): string {
  const lastSegment = name.split('/').pop() ?? name;
  return slugLabel(lastSegment, maxLength);
}

/**
 * How many characters the branch label may use, given the other labels it has to
 * share a hostname with.
 *
 * Per-label capping alone is not enough: three maxed labels plus a tld exceed the
 * 253-character hostname ceiling, and the failure mode is a host the browser
 * silently refuses rather than an error anyone can read.
 */
export function branchLabelBudget({
  service,
  project,
  tld,
  prefix,
}: {
  service?: string | null;
  project?: string | null;
  tld: string;
  /** The longest prefix the app will put in front of the route key. */
  prefix?: string | null;
}): number {
  const fixed = [service, project, tld, prefix]
    .filter((part): part is string => Boolean(part))
    // +1 for the '.' separator each part contributes.
    .reduce((total, part) => total + part.length + 1, 0);
  return Math.max(1, Math.min(MAX_LABEL_LENGTH, MAX_HOSTNAME_LENGTH - fixed));
}

/**
 * Resolve the route key this checkout may claim, suffixing the BRANCH label
 * (`feature-x-2.myapp`, never `feature-x.myapp-2`) until one is free.
 *
 * With the project label in the host this is a rare fallback rather than the
 * common path. It now only fires for two checkouts of the SAME project on the
 * SAME branch - a linked worktree and the main checkout both on `main` - which is
 * the only case where an arbitrary suffix is honest. Before the project label,
 * every project sharing a branch name landed here, and which one got the
 * unsuffixed URL depended on serve order and flipped between boots.
 */
export function disambiguateRouteKey(
  parts: RouteParts,
  isFree: (routeKey: string) => boolean,
): { routeKey: string; parts: RouteParts } {
  const preferred = buildRouteKey(parts);
  if (isFree(preferred)) {
    return { routeKey: preferred, parts };
  }
  // A distinct n always yields a distinct label and the registry is finite, so
  // the first free suffix is always reached.
  for (let n = 2; ; n++) {
    const branch = suffixLabel(parts.branch, n);
    const candidate = buildRouteKey({ ...parts, branch });
    if (isFree(candidate)) {
      return { routeKey: candidate, parts: { ...parts, branch } };
    }
  }
}

// Appending to an already-maxed label would push it past the DNS limit, so the
// base is trimmed to make room for the suffix, then re-trimmed of any dash the
// slice exposed.
function suffixLabel(label: string, n: number): string {
  const suffix = `-${n}`;
  const base = label
    .slice(0, MAX_LABEL_LENGTH - suffix.length)
    .replace(/-+$/, '');
  return `${base}${suffix}`;
}
