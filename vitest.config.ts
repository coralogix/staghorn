import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    // `forks`, not the default `threads`. The registry and lease layers install
    // process.once('exit'|'SIGINT'|'SIGTERM') handlers and read/write
    // process.env; both misbehave when several suites share one worker thread.
    pool: 'forks',
    // Every test that touches the daemon binds an ephemeral port, so suites are
    // safe to parallelise - but a stuck socket should fail fast, not hang CI.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
