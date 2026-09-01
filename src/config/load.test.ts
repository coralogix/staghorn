// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from '../log';
import {
  CONFIG_FILENAMES,
  configFromEnv,
  loadConfig,
  type ConfigInput,
} from './load';
import type { StaghornConfig } from './types';

describe('loadConfig defaults', () => {
  it('returns the defaults when nothing is configured', async () => {
    const { config } = await load({});
    expect(config).toMatchObject({ enabled: true, activate: 'always', tld: 'localhost' });
  });

  // 'always', not 'linkedWorktree': a consumer with a single clone still wants a
  // named URL, and refusing them refuses most of the audience.
  it('activates always by default', async () => {
    expect((await load({})).config.activate).toBe('always');
  });
});

describe('loadConfig discovery', () => {
  it('reads a project config from the cwd', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'localtest.me' } },
    });
    expect(config.tld).toBe('localtest.me');
  });

  it('walks up to find a project config', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'from-root' } },
      cwdSuffix: 'packages/app/src',
    });
    expect(config.tld).toBe('from-root');
  });

  it('reads a package.json staghorn key', async () => {
    const { config } = await load({
      files: { 'package.json': { name: 'x', staghorn: { tld: 'from-pkg' } } },
    });
    expect(config.tld).toBe('from-pkg');
  });

  it('prefers a dedicated config file over the package.json key', async () => {
    const { config } = await load({
      files: {
        'staghorn.config.json': { tld: 'from-file' },
        'package.json': { name: 'x', staghorn: { tld: 'from-pkg' } },
      },
    });
    expect(config.tld).toBe('from-file');
  });

  it('prefers the nearest config when several are on the path', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'far' } },
      nestedFiles: { 'packages/app/staghorn.config.json': { tld: 'near' } },
      cwdSuffix: 'packages/app',
    });
    expect(config.tld).toBe('near');
  });

  it('stops walking at the boundary', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'above-boundary' } },
      cwdSuffix: 'packages/app',
      stopAtSuffix: 'packages',
    });
    expect(config.tld).toBe('localhost');
  });

  it('records which files were read', async () => {
    const { files } = await load({
      files: { 'staghorn.config.json': { tld: 'x' } },
    });
    expect(files.some((file) => file.endsWith('staghorn.config.json'))).toBe(true);
  });

  it('looks for every documented filename', () => {
    expect(CONFIG_FILENAMES).toContain('staghorn.config.ts');
    expect(CONFIG_FILENAMES).toContain('staghorn.config.mjs');
    expect(CONFIG_FILENAMES).toContain('.staghornrc.json');
  });
});

describe('loadConfig precedence', () => {
  it('env beats a project config file', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'from-file' } },
      env: { STAGHORN_TLD: 'from-env' },
    });
    expect(config.tld).toBe('from-env');
  });

  it('flags beat env', async () => {
    const { config } = await load({
      env: { STAGHORN_TLD: 'from-env' },
      flags: { tld: 'from-flags' },
    });
    expect(config.tld).toBe('from-flags');
  });

  it('programmatic options beat flags', async () => {
    const { config } = await load({
      flags: { tld: 'from-flags' },
      programmatic: { tld: 'from-api' },
    });
    expect(config.tld).toBe('from-api');
  });

  // The deliberate last layer: a developer's machine reality has to be able to
  // beat their team's project config, or they simply cannot use the tool.
  it('user overrides beat everything, including programmatic options', async () => {
    const { config } = await load({
      userConfig: { tld: 'from-user', overrides: { tld: 'from-user-overrides' } },
      files: { 'staghorn.config.json': { tld: 'from-file' } },
      programmatic: { tld: 'from-api' },
    });
    expect(config.tld).toBe('from-user-overrides');
  });

  it('a plain user config still loses to the project config', async () => {
    const { config } = await load({
      userConfig: { tld: 'from-user' },
      files: { 'staghorn.config.json': { tld: 'from-file' } },
    });
    expect(config.tld).toBe('from-file');
  });

  // `overrides` in a project config would just be a second copy of the same
  // layer, so it is dropped rather than silently honoured.
  it('ignores an overrides block in a project config', async () => {
    const { config } = await load({
      files: {
        'staghorn.config.json': { tld: 'from-file', overrides: { tld: 'sneaky' } },
      },
    });
    expect(config.tld).toBe('from-file');
  });

  it('deep-merges nested objects across layers', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { proxy: { sharedPort: 5000 } } },
      programmatic: { proxy: { forwardedHeaders: false } },
    });
    expect(config.proxy).toEqual({ sharedPort: 5000, forwardedHeaders: false });
  });

  // Overriding an array means "these", not "these as well as the defaults".
  it('replaces arrays rather than concatenating them', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { aliases: ['a', 'b'] } },
      programmatic: { aliases: ['c'] },
    });
    expect(config.aliases).toEqual(['c']);
  });

  it('ignores undefined values instead of letting them erase a lower layer', async () => {
    const { config } = await load({
      files: { 'staghorn.config.json': { tld: 'from-file' } },
      programmatic: { tld: undefined },
    });
    expect(config.tld).toBe('from-file');
  });
});

describe('loadConfig provenance', () => {
  it('records where each winning value came from', async () => {
    const { provenance } = await load({
      files: { 'staghorn.config.json': { tld: 'from-file' } },
      env: { STAGHORN_LOG: 'debug' },
      programmatic: { enabled: false },
    });
    expect(provenance.get('tld')?.layer).toBe('project');
    expect(provenance.get('tld')?.file).toMatch(/staghorn\.config\.json$/);
    expect(provenance.get('log.level')?.layer).toBe('env');
    expect(provenance.get('enabled')?.layer).toBe('programmatic');
  });

  it('attributes untouched keys to the defaults', async () => {
    const { provenance } = await load({});
    expect(provenance.get('activate')?.layer).toBe('default');
  });
});

describe('loadConfig failures', () => {
  it('warns about a config file that exists but cannot be parsed', async () => {
    const { logger, config } = await load({ rawFiles: { 'staghorn.config.json': '{ oops' } });
    // Loud, because a config file that is present and broken is a real problem -
    // unlike one that simply is not there.
    expect(logger.records.some((record) => record.level === 'warn')).toBe(true);
    expect(config.tld).toBe('localhost');
  });

  it('ignores a package.json with no staghorn key', async () => {
    const { config } = await load({ files: { 'package.json': { name: 'x' } } });
    expect(config.tld).toBe('localhost');
  });
});

describe('configFromEnv', () => {
  it('maps the documented environment variables', () => {
    expect(
      configFromEnv({
        STAGHORN_DISABLE: '1',
        STAGHORN_TLD: 'localtest.me',
        STAGHORN_MODE: 'sharedPort',
        STAGHORN_STATE_DIR: '/tmp/state',
        STAGHORN_LOG: 'debug',
        STAGHORN_PORT: '3000',
        STAGHORN_PROJECT: 'cx',
      }),
    ).toEqual({
      enabled: false,
      tld: 'localtest.me',
      proxy: { mode: 'sharedPort' },
      state: { dir: '/tmp/state' },
      log: { level: 'debug' },
      ports: { strategy: 'fixed', fixed: 3000 },
      identity: { project: 'cx' },
    });
  });

  it('reads STAGHORN_PROJECT=false as flattening the project label', () => {
    expect(configFromEnv({ STAGHORN_PROJECT: 'false' })).toEqual({
      identity: { project: false },
    });
  });

  it('ignores values it does not recognise', () => {
    expect(
      configFromEnv({ STAGHORN_MODE: 'nonsense', STAGHORN_LOG: 'loud', STAGHORN_PORT: 'abc' }),
    ).toEqual({});
  });

  it('returns nothing for an empty environment', () => {
    expect(configFromEnv({})).toEqual({});
  });
});

// --- harness -------------------------------------------------------------

async function load({
  files = {},
  nestedFiles = {},
  rawFiles = {},
  userConfig,
  env = {},
  flags = {},
  programmatic = {},
  cwdSuffix,
  stopAtSuffix,
}: {
  files?: Record<string, unknown>;
  nestedFiles?: Record<string, unknown>;
  rawFiles?: Record<string, string>;
  userConfig?: StaghornConfig;
  env?: NodeJS.ProcessEnv;
  flags?: ConfigInput;
  programmatic?: ConfigInput;
  cwdSuffix?: string;
  stopAtSuffix?: string;
}): Promise<
  Awaited<ReturnType<typeof loadConfig>> & {
    logger: ReturnType<typeof createRecordingLogger>;
  }
> {
  const root = mkdtempSync(join(tmpdir(), 'staghorn-config-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), JSON.stringify(contents), 'utf8');
  }
  for (const [name, contents] of Object.entries(rawFiles)) {
    writeFileSync(join(root, name), contents, 'utf8');
  }
  for (const [relative, contents] of Object.entries(nestedFiles)) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, JSON.stringify(contents), 'utf8');
  }
  const cwd = cwdSuffix ? join(root, cwdSuffix) : root;
  mkdirSync(cwd, { recursive: true });

  const logger = createRecordingLogger();
  const result = await loadConfig({
    cwd,
    env,
    flags,
    programmatic,
    logger,
    ...(stopAtSuffix ? { stopAt: join(root, stopAtSuffix) } : { stopAt: root }),
    // The user config lives outside the temp tree, so it is injected rather than
    // written to the real $XDG_CONFIG_HOME - a test must never touch that.
    // The user config would otherwise live in the real $XDG_CONFIG_HOME, which a
    // test must never read or write. Anything inside the temp tree is a project
    // config; anything outside it is the user config.
    ...(userConfig
      ? {
          readConfigFile: async (path: string) =>
            path.startsWith(root) ? readJsonIfPresent(path) : userConfig,
        }
      : {}),
  });
  return { ...result, logger };
}

function readJsonIfPresent(path: string): StaghornConfig | null {
  if (!path.endsWith('.json')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
