import { describe, expect, it } from 'vitest';

import { PORT_MAX, PORT_MIN, preferredPort } from './hash';
import { pickPort } from './probe';

const allFree = () => Promise.resolve(true);

describe('pickPort', () => {
  it('defaults the first candidate to the route-key hash', async () => {
    const port = await pickPort('main.myapp', { isFree: allFree });
    expect(port).toBe(preferredPort('main.myapp'));
  });

  // The `order: 'sequential'` config resolves to preferred = range bottom: the
  // first serve on a machine gets exactly range[0], which is what keeps an
  // externally pinned port (an SSO bookmark, a proxy allowlist) matching it.
  it('honours an explicit preferred candidate over the hash', async () => {
    const port = await pickPort('main.myapp', { preferred: PORT_MIN, isFree: allFree });
    expect(port).toBe(PORT_MIN);
  });

  it('walks forward from the preferred candidate past busy ports', async () => {
    const isFree = (port: number) => Promise.resolve(port !== PORT_MIN);
    const port = await pickPort('main.myapp', { preferred: PORT_MIN, isFree });
    expect(port).toBe(PORT_MIN + 1);
  });

  // Claimed = registered by another route but possibly not bound yet, so the
  // bind probe alone cannot see it. Sequential order makes every start share
  // the same first candidate, which is exactly when this skip earns its keep.
  it('skips ports other routes claimed even when they are bindable', async () => {
    const claimed = new Set([PORT_MIN, PORT_MIN + 1]);
    const port = await pickPort('main.myapp', {
      preferred: PORT_MIN,
      claimed,
      isFree: allFree,
    });
    expect(port).toBe(PORT_MIN + 2);
  });

  it('wraps past the top of the range and keeps probing', async () => {
    const isFree = (port: number) => Promise.resolve(port === PORT_MIN);
    const port = await pickPort('main.myapp', { preferred: PORT_MAX, isFree });
    expect(port).toBe(PORT_MIN);
  });

  it('returns null when the whole range is exhausted', async () => {
    const neverFree = () => Promise.resolve(false);
    const port = await pickPort('main.myapp', {
      min: 4200,
      max: 4205,
      isFree: neverFree,
    });
    expect(port).toBeNull();
  });

  it('maps an out-of-range preferred candidate back into the range', async () => {
    const port = await pickPort('main.myapp', {
      preferred: 9999,
      min: 4200,
      max: 4205,
      isFree: allFree,
    });
    expect(port).toBeGreaterThanOrEqual(4200);
    expect(port).toBeLessThanOrEqual(4205);
  });
});
