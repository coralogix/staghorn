import { describe, expect, it } from 'vitest';

import {
  buildHost,
  buildRouteKey,
  isControlHost,
  labelsUnderTld,
  matchHost,
  splitHostHeader,
} from './host';

describe('buildRouteKey', () => {
  it('puts project rightmost so *.project.<tld> is one meaningful wildcard', () => {
    expect(buildRouteKey({ branch: 'feature-x', project: 'myapp' })).toBe(
      'feature-x.myapp',
    );
  });

  it('inserts a service label left of the branch', () => {
    expect(
      buildRouteKey({
        service: 'storybook',
        branch: 'feature-x',
        project: 'myapp',
      }),
    ).toBe('storybook.feature-x.myapp');
  });

  it('omits the project label when flattened away', () => {
    expect(buildRouteKey({ branch: 'feature-x', project: null })).toBe(
      'feature-x',
    );
  });

  it('omits the default (null) service so single-server hosts stay short', () => {
    expect(
      buildRouteKey({ service: null, branch: 'main', project: 'myapp' }),
    ).toBe('main.myapp');
  });
});

describe('buildHost', () => {
  it('omits the port on the portless rung', () => {
    expect(buildHost({ routeKey: 'main.myapp' })).toBe('main.myapp.localhost');
  });

  it('keeps the hostname identical when a port is added, so bookmarks survive a degrade', () => {
    const portless = buildHost({ routeKey: 'main.myapp' });
    const ported = buildHost({ routeKey: 'main.myapp', port: 4180 });
    expect(ported).toBe(`${portless}:4180`);
  });

  it('prepends the app-facing prefix', () => {
    expect(buildHost({ routeKey: 'main.myapp', prefix: 'dashboard' })).toBe(
      'dashboard.main.myapp.localhost',
    );
  });

  it('honours a custom tld', () => {
    expect(buildHost({ routeKey: 'main.myapp', tld: 'localtest.me' })).toBe(
      'main.myapp.localtest.me',
    );
  });
});

describe('splitHostHeader', () => {
  it('splits hostname and port', () => {
    expect(splitHostHeader('main.myapp.localhost:4180')).toEqual({
      hostname: 'main.myapp.localhost',
      port: 4180,
    });
  });

  it('lowercases the hostname', () => {
    expect(splitHostHeader('MAIN.MyApp.localhost')?.hostname).toBe(
      'main.myapp.localhost',
    );
  });

  // The original implementation did hostHeader.split(':')[0], which yields '['.
  it('handles the bracketed IPv6 form', () => {
    expect(splitHostHeader('[::1]:80')).toEqual({ hostname: '::1', port: 80 });
    expect(splitHostHeader('[::1]')).toEqual({ hostname: '::1', port: null });
  });

  it('returns null for absent or blank headers', () => {
    expect(splitHostHeader(undefined)).toBeNull();
    expect(splitHostHeader('   ')).toBeNull();
  });
});

describe('labelsUnderTld', () => {
  it('returns the labels beneath the tld, left to right', () => {
    expect(labelsUnderTld('dashboard.main.myapp.localhost')).toEqual([
      'dashboard',
      'main',
      'myapp',
    ]);
  });

  // A multi-label tld must be stripped as a suffix string, not one label.
  it('strips a multi-label tld whole', () => {
    expect(labelsUnderTld('main.myapp.localtest.me', 'localtest.me')).toEqual([
      'main',
      'myapp',
    ]);
  });

  it('returns null for the bare tld and for foreign hosts', () => {
    expect(labelsUnderTld('localhost')).toBeNull();
    expect(labelsUnderTld('example.com')).toBeNull();
    expect(labelsUnderTld('127.0.0.1')).toBeNull();
  });

  it('rejects hosts with an empty label', () => {
    expect(labelsUnderTld('main..myapp.localhost')).toBeNull();
  });
});

describe('matchHost', () => {
  const registered = registry([
    'main.myapp',
    'feature-x.myapp',
    'storybook.feature-x.myapp',
    'main.other',
    'dev',
  ]);

  it('matches the exact route with no prefix', () => {
    expect(matchHost('feature-x.myapp.localhost', registered)).toEqual({
      routeKey: 'feature-x.myapp',
      prefix: [],
    });
  });

  it('ignores an arbitrary app prefix', () => {
    expect(matchHost('dashboard.feature-x.myapp.localhost', registered)).toEqual(
      { routeKey: 'feature-x.myapp', prefix: ['dashboard'] },
    );
  });

  it('ignores several prefix labels', () => {
    expect(
      matchHost('a.b.c.feature-x.myapp.localhost', registered),
    ).toEqual({ routeKey: 'feature-x.myapp', prefix: ['a', 'b', 'c'] });
  });

  // The precedence the whole shape depends on: the longer registered suffix wins,
  // so a service route is never swallowed by the app route beneath it.
  it('prefers the longer registered suffix (service beats app)', () => {
    expect(
      matchHost('storybook.feature-x.myapp.localhost', registered),
    ).toEqual({ routeKey: 'storybook.feature-x.myapp', prefix: [] });
  });

  it('still absorbs a prefix above a service route', () => {
    expect(
      matchHost('team-a.storybook.feature-x.myapp.localhost', registered),
    ).toEqual({ routeKey: 'storybook.feature-x.myapp', prefix: ['team-a'] });
  });

  // The reason the project label exists: same branch, two projects, no collision
  // and no order-dependent -2 suffix.
  it('keeps identically-named branches in different projects apart', () => {
    expect(matchHost('main.myapp.localhost', registered)?.routeKey).toBe(
      'main.myapp',
    );
    expect(matchHost('main.other.localhost', registered)?.routeKey).toBe(
      'main.other',
    );
  });

  it('matches a single-label alias for a fixed-origin redirect URI', () => {
    expect(matchHost('dev.localhost', registered)).toEqual({
      routeKey: 'dev',
      prefix: [],
    });
  });

  it('returns null when nothing is registered for the host', () => {
    expect(matchHost('unknown.myapp.localhost', registered)).toBeNull();
    expect(matchHost('localhost', registered)).toBeNull();
    expect(matchHost('example.com', registered)).toBeNull();
  });

  it('does not match a bare project label unless one is registered', () => {
    expect(matchHost('myapp.localhost', registered)).toBeNull();
    expect(matchHost('myapp.localhost', registry(['myapp']))?.routeKey).toBe(
      'myapp',
    );
  });
});

describe('isControlHost', () => {
  it('is true for the bare tld and loopback literals', () => {
    expect(isControlHost('localhost')).toBe(true);
    expect(isControlHost('localhost:4180')).toBe(true);
    expect(isControlHost('127.0.0.1:4180')).toBe(true);
    expect(isControlHost('[::1]:4180')).toBe(true);
  });

  it('is true when there is no Host header at all', () => {
    expect(isControlHost(undefined)).toBe(true);
  });

  // This is what keeps the control paths out of every consumer app's path space.
  it('is false for any host that carries a route', () => {
    expect(isControlHost('main.myapp.localhost')).toBe(false);
    expect(isControlHost('dashboard.main.myapp.localhost')).toBe(false);
  });
});

function registry(keys: string[]): (routeKey: string) => boolean {
  const set = new Set(keys);
  return (routeKey) => set.has(routeKey);
}
