// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import { onSignal } from './create-dev-domain';

// `process.once` removes a listener before invoking it, so a handler built here is
// called with the registration already gone - which is what the count below reflects.
describe('onSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners('SIGUSR2');
  });

  it('cleans up and exits when nothing else is listening', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      // The real one never returns; swallowing it keeps the test process alive.
      return undefined as never;
    }) as typeof process.exit);
    const cleanup = vi.fn();

    onSignal('SIGUSR2', 143, cleanup)();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
  });

  // The regression this guards: a wrapped command (`staghorn -- <cmd>`) registers its
  // forward AFTER this handler, because it cannot spawn before the domain resolves.
  // Exiting here would run first and orphan the child, leaving a dev server holding
  // its port with no route pointing at it.
  it('cleans up but defers the exit when another handler is registered', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);
    const cleanup = vi.fn();
    process.on('SIGUSR2', () => {});

    onSignal('SIGUSR2', 143, cleanup)();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
