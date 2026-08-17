// Regression test for a bug that unit tests structurally cannot catch.
//
// `ensureProxy` waits between spawn-poll attempts. That wait used an UNREFFED timer,
// so whenever it was the only thing holding the event loop open - precisely the state
// of a dev-serve script that has not started its dev server yet - Node decided the
// program was finished and exited with code 0, silently, mid-poll, killing the host
// process. The package's central promise is that it never breaks the caller's dev
// server, and that version broke it with no message at all.
//
// Every other test injects `delay`, so none of them touch the real timer. The only
// way to observe this is to run the real thing in a BARE process with nothing else
// keeping the loop alive, and check that execution continues past the await.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ensureProxy keeps the host process alive while it waits', () => {
  // A port nothing is on, so ensureProxy takes the spawn-and-poll path - the one that
  // waits - and cannot succeed. What matters is only that we get an answer at all.
  it('resolves instead of letting the process exit silently', () => {
    const output = runInBareProcess(`
      import { ensureProxy } from ${JSON.stringify(entryUrl())};
      const result = await ensureProxy(
        { wildcardPort: 9, sharedPort: 9, spawnPollAttempts: 2, spawnPollIntervalMs: 60 },
        { spawnDaemon: () => {}, entryResolver: { resolve: () => '/nonexistent', reset() {} } },
      );
      console.log('RESOLVED:' + result.mode);
    `);
    // Before the fix this printed nothing at all and exited 0.
    expect(output).toContain('RESOLVED:');
  });

  it('a plain unreffed timer really does let a bare process exit, so the guard is meaningful', () => {
    // Pins the mechanism itself. If a future Node stops exiting here, this test fails
    // and tells the next reader that the guard above is now belt-and-braces.
    const output = runInBareProcess(`
      await new Promise((r) => { const h = setTimeout(r, 200); h.unref(); });
      console.log('SHOULD-NOT-PRINT');
    `);
    expect(output).not.toContain('SHOULD-NOT-PRINT');
  });
});

function entryUrl(): string {
  // Import the source through the same loader vitest uses, so this tests the real
  // module rather than a build artefact that may not exist yet.
  return new URL('./ensure-proxy.ts', import.meta.url).href;
}

function runInBareProcess(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'staghorn-keepalive-'));
  const file = join(dir, 'probe.mts');
  writeFileSync(file, source, 'utf8');
  try {
    return execFileSync(
      process.execPath,
      ['--import', 'tsx', file],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        // A bare process: no vitest, no test runner, nothing else on the loop.
        env: { ...process.env, STAGHORN_STATE_DIR: join(dir, 'state') },
      },
    );
  } catch (err) {
    // A non-zero exit is itself a failure signal; surface whatever was printed.
    const stdout =
      typeof err === 'object' && err !== null && 'stdout' in err
        ? String(err.stdout)
        : '';
    return stdout;
  }
}
