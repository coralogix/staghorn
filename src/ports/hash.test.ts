// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { PORT_MAX, PORT_MIN, nextPortCandidate, preferredPort } from './hash';

describe('preferredPort', () => {
  it('is deterministic for a route key', () => {
    expect(preferredPort('main.myapp')).toBe(preferredPort('main.myapp'));
  });

  it('stays inside the range for every input shape', () => {
    for (const key of [
      '',
      'a',
      'main.myapp',
      'storybook.feature-x.myapp',
      'b'.repeat(63),
      'z'.repeat(250),
    ]) {
      const port = preferredPort(key);
      expect(port).toBeGreaterThanOrEqual(PORT_MIN);
      expect(port).toBeLessThanOrEqual(PORT_MAX);
    }
  });

  // The point of hashing the whole route key rather than the branch: the project
  // label is what separates two checkouts that share the commonest branch name.
  it('separates the same branch across projects', () => {
    expect(preferredPort('main.myapp')).not.toBe(preferredPort('main.other'));
  });

  it('separates services within one checkout', () => {
    expect(preferredPort('feature-x.myapp')).not.toBe(
      preferredPort('storybook.feature-x.myapp'),
    );
  });
});

describe('nextPortCandidate', () => {
  it('increments inside the range', () => {
    expect(nextPortCandidate(PORT_MIN)).toBe(PORT_MIN + 1);
  });

  it('wraps at the top so probing always terminates', () => {
    expect(nextPortCandidate(PORT_MAX)).toBe(PORT_MIN);
  });

  it('honours a custom range', () => {
    expect(nextPortCandidate(5, 1, 5)).toBe(1);
  });

  it('visits every port in the range exactly once before repeating', () => {
    const min = 100;
    const max = 104;
    const seen = new Set<number>();
    let port = min + 2;
    for (let i = 0; i <= max - min; i++) {
      seen.add(port);
      port = nextPortCandidate(port, min, max);
    }
    expect(seen.size).toBe(max - min + 1);
    expect(port).toBe(min + 2);
  });
});
