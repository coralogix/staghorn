import { describe, expect, it } from 'vitest';

import { MAX_HOSTNAME_LENGTH, MAX_LABEL_LENGTH } from '../host';
import {
  branchLabelBudget,
  branchToLabel,
  disambiguateRouteKey,
  projectToLabel,
  slugLabel,
} from './slug';

describe('slugLabel', () => {
  it('preserves the whole name, flattened', () => {
    expect(slugLabel('feature/Add-Search')).toBe('feature-add-search');
  });

  it('collapses runs of illegal characters to a single dash', () => {
    expect(slugLabel('feat//__..some  thing')).toBe('feat-some-thing');
  });

  it('trims dashes from both edges', () => {
    expect(slugLabel('---main---')).toBe('main');
  });

  it('caps at the DNS label limit without leaving a trailing dash', () => {
    const label = slugLabel(`${'a'.repeat(MAX_LABEL_LENGTH)}-tail`);
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(label.endsWith('-')).toBe(false);
  });

  it('never lets a caller raise the cap above the DNS limit', () => {
    expect(slugLabel('a'.repeat(200), 500).length).toBe(MAX_LABEL_LENGTH);
  });
});

describe('projectToLabel', () => {
  it('drops the npm scope', () => {
    expect(projectToLabel('@acme/web-app')).toBe('web-app');
  });

  it('leaves an unscoped name alone', () => {
    expect(projectToLabel('myapp')).toBe('myapp');
  });
});

describe('branchLabelBudget', () => {
  it('leaves room for the other labels in the hostname', () => {
    const budget = branchLabelBudget({ project: 'myapp', tld: 'localhost' });
    expect(budget).toBe(MAX_LABEL_LENGTH);
  });

  it('shrinks below the label cap when the other labels are long', () => {
    const budget = branchLabelBudget({
      service: 'storybook',
      project: 'p'.repeat(60),
      prefix: 'x'.repeat(120),
      tld: 'localtest.me',
    });
    expect(budget).toBeLessThan(MAX_LABEL_LENGTH);
    expect(budget).toBeGreaterThan(0);
  });

  it('keeps the assembled hostname inside the RFC ceiling', () => {
    const parts = {
      service: 'storybook',
      project: 'p'.repeat(63),
      prefix: 'x'.repeat(63),
      tld: 'localtest.me',
    };
    const branch = branchToLabel('b'.repeat(200), branchLabelBudget(parts));
    const hostname = [
      parts.prefix,
      parts.service,
      branch,
      parts.project,
      parts.tld,
    ].join('.');
    expect(hostname.length).toBeLessThanOrEqual(MAX_HOSTNAME_LENGTH);
  });

  it('never returns a non-positive budget', () => {
    expect(
      branchLabelBudget({ project: 'p'.repeat(250), tld: 'localhost' }),
    ).toBeGreaterThan(0);
  });
});

describe('disambiguateRouteKey', () => {
  const parts = { branch: 'main', project: 'myapp' };

  it('claims the preferred key when it is free', () => {
    expect(disambiguateRouteKey(parts, () => true)).toEqual({
      routeKey: 'main.myapp',
      parts,
    });
  });

  // The suffix belongs on the branch, not the project: feature-x-2.myapp reads as
  // "a second checkout of that branch", feature-x.myapp-2 reads as a second app.
  it('suffixes the branch label, never the project label', () => {
    const taken = new Set(['main.myapp']);
    const result = disambiguateRouteKey(
      parts,
      (routeKey) => !taken.has(routeKey),
    );
    expect(result.routeKey).toBe('main-2.myapp');
    expect(result.parts.branch).toBe('main-2');
    expect(result.parts.project).toBe('myapp');
  });

  it('keeps counting past the first suffix', () => {
    const taken = new Set(['main.myapp', 'main-2.myapp', 'main-3.myapp']);
    expect(
      disambiguateRouteKey(parts, (routeKey) => !taken.has(routeKey)).routeKey,
    ).toBe('main-4.myapp');
  });

  it('trims the base to keep a suffixed label legal', () => {
    const long = { branch: 'b'.repeat(MAX_LABEL_LENGTH), project: 'myapp' };
    const taken = new Set([`${long.branch}.myapp`]);
    const { parts: next } = disambiguateRouteKey(
      long,
      (routeKey) => !taken.has(routeKey),
    );
    expect(next.branch.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(next.branch.endsWith('-2')).toBe(true);
  });

  // With the project label present, two projects on the same branch never reach
  // the suffix path at all - this is the regression that made URLs unstable.
  it('does not fire for the same branch in different projects', () => {
    const taken = new Set(['main.other']);
    expect(
      disambiguateRouteKey(parts, (routeKey) => !taken.has(routeKey)).routeKey,
    ).toBe('main.myapp');
  });
});
