import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from './log';
import {
  DAEMON_FILENAME,
  DAEMON_SPECIFIER,
  PROXY_ENTRY_ENV,
  createProxyEntryResolver,
  isZipMounted,
  nodeBinary,
  type ProxyEntryDeps,
} from './resolve-proxy-entry';

describe('createProxyEntryResolver', () => {
  it('finds the daemon next to the running module', () => {
    const { resolver } = staged({ files: ['/pkg/dist/proxy.mjs'] });
    expect(resolver.resolve()).toBe('/pkg/dist/proxy.mjs');
  });

  it('memoises the answer', () => {
    let calls = 0;
    const { resolver } = staged({
      files: ['/pkg/dist/proxy.mjs'],
      onExists: () => {
        calls++;
      },
    });
    resolver.resolve();
    const after = calls;
    resolver.resolve();
    expect(calls).toBe(after);
  });

  it('forgets the answer on reset', () => {
    const files = new Set<string>();
    const { resolver } = staged({ files });
    expect(resolver.resolve()).toBeNull();

    files.add('/pkg/dist/proxy.mjs');
    resolver.reset();
    expect(resolver.resolve()).toBe('/pkg/dist/proxy.mjs');
  });
});

describe('createProxyEntryResolver overrides', () => {
  it('prefers the env override over everything', () => {
    const { resolver } = staged({
      files: ['/pkg/dist/proxy.mjs', '/custom/daemon.mjs'],
      env: { [PROXY_ENTRY_ENV]: '/custom/daemon.mjs' },
    });
    expect(resolver.resolve()).toBe('/custom/daemon.mjs');
  });

  // The one loud failure in the module: an override that silently did nothing
  // would be worse than having no override.
  it('throws when the env override is not usable', () => {
    const { resolver } = staged({
      files: ['/pkg/dist/proxy.mjs'],
      env: { [PROXY_ENTRY_ENV]: '/nope/missing.mjs' },
    });
    expect(() => resolver.resolve()).toThrow(/is not a file this process can spawn/);
  });

  it('accepts an explicit caller-supplied path', () => {
    const { resolver } = staged({ files: ['/mono/daemon.mjs'] });
    expect(resolver.resolve('/mono/daemon.mjs')).toBe('/mono/daemon.mjs');
  });

  it('falls through when the explicit path does not exist', () => {
    const { resolver } = staged({ files: ['/pkg/dist/proxy.mjs'] });
    expect(resolver.resolve('/mono/gone.mjs')).toBe('/pkg/dist/proxy.mjs');
  });
});

describe('createProxyEntryResolver recovery', () => {
  // The case where a consumer bundled our library into their own dev script, so
  // import.meta.url points into their bundle and the sibling is not there.
  it('resolves by package specifier when the sibling is missing', () => {
    const { resolver } = staged({
      files: ['/elsewhere/node_modules/dev-domains/dist/proxy.mjs'],
      resolved: '/elsewhere/node_modules/dev-domains/dist/proxy.mjs',
    });
    expect(resolver.resolve()).toBe(
      '/elsewhere/node_modules/dev-domains/dist/proxy.mjs',
    );
  });

  it('returns null and warns when nothing is found', () => {
    const { resolver, logger } = staged({ files: [] });
    expect(resolver.resolve()).toBeNull();
    expect(
      logger.records.some(
        (record) =>
          record.level === 'warn' && record.msg.includes(PROXY_ENTRY_ENV),
      ),
    ).toBe(true);
  });
});

describe('createProxyEntryResolver materialize', () => {
  // Yarn PnP zips: fs is patched, child_process is not. Readable, unspawnable.
  it('copies the daemon out of a zip-mounted package', () => {
    const { resolver, written } = staged({
      files: ['/repo/.yarn/cache/dev-domains-npm-0.1.0.zip/node_modules/dev-domains/dist/proxy.mjs'],
      resolved:
        '/repo/.yarn/cache/dev-domains-npm-0.1.0.zip/node_modules/dev-domains/dist/proxy.mjs',
      selfDir: '/repo/.yarn/cache/dev-domains-npm-0.1.0.zip/node_modules/dev-domains/dist',
    });

    const entry = resolver.resolve();
    expect(entry).toMatch(/^\/state\/bin\/proxy-9\.9\.9-[0-9a-f]{16}\.mjs$/);
    expect(written.some(([path]) => path.includes('.tmp-'))).toBe(true);
  });

  it('reuses an already-relocated copy instead of rewriting it', () => {
    const files = new Set([
      '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist/proxy.mjs',
    ]);
    const first = staged({
      files,
      selfDir: '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist',
    });
    const target = first.resolver.resolve();
    expect(target).not.toBeNull();

    // Second process, same content: the file is already there.
    files.add(target as string);
    const second = staged({
      files,
      selfDir: '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist',
    });
    expect(second.resolver.resolve()).toBe(target);
    expect(second.written).toEqual([]);
  });

  it('falls back to the next base when the first is not writable', () => {
    const { resolver } = staged({
      files: ['/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist/proxy.mjs'],
      selfDir: '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist',
      unwritable: ['/state/bin'],
    });
    expect(resolver.resolve()).toMatch(/^\/tmp\/staghorn-bin\//);
  });

  it('returns null when no base is writable', () => {
    const { resolver } = staged({
      files: ['/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist/proxy.mjs'],
      selfDir: '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist',
      unwritable: ['/state/bin', '/tmp/staghorn-bin'],
    });
    expect(resolver.resolve()).toBeNull();
  });

  it('names the copy by content, so two versions can coexist', () => {
    const stage = (text: string): string | null =>
      staged({
        files: ['/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist/proxy.mjs'],
        selfDir: '/repo/.yarn/cache/p.zip/node_modules/dev-domains/dist',
        text,
      }).resolver.resolve();
    expect(stage('daemon v1')).not.toBe(stage('daemon v2'));
  });
});

describe('isZipMounted', () => {
  it('detects a yarn zip path', () => {
    expect(
      isZipMounted('/r/.yarn/cache/dev-domains-npm-0.1.0.zip/node_modules/x/proxy.mjs'),
    ).toBe(true);
  });

  it('leaves ordinary node_modules paths alone', () => {
    expect(isZipMounted('/r/node_modules/dev-domains/dist/proxy.mjs')).toBe(false);
    expect(isZipMounted('/r/node_modules/.store/x/dist/proxy.mjs')).toBe(false);
  });

  it('does not fire on a file merely named *.zip', () => {
    expect(isZipMounted('/downloads/archive.zip')).toBe(false);
  });
});

describe('nodeBinary', () => {
  it('uses execPath on plain node', () => {
    expect(nodeBinary({}, { ...process.versions })).toBe(process.execPath);
  });

  // The lease protocol relies on Node socket semantics, so a real node is
  // preferred when the host runtime is not one.
  it('looks for a real node under bun', () => {
    const versions = { ...process.versions, bun: '1.2.0' };
    expect(nodeBinary({ PATH: '/definitely/not/here' }, versions)).toBe(
      process.execPath,
    );
  });
});

// --- staging -------------------------------------------------------------

function staged({
  files,
  resolved = null,
  selfDir = '/pkg/dist',
  env = {},
  unwritable = [],
  text = 'daemon',
  onExists,
}: {
  files: Iterable<string>;
  resolved?: string | null;
  selfDir?: string;
  env?: NodeJS.ProcessEnv;
  unwritable?: readonly string[];
  text?: string;
  onExists?: (path: string) => void;
}): {
  resolver: ReturnType<typeof createProxyEntryResolver>;
  logger: ReturnType<typeof createRecordingLogger>;
  written: Array<[string, string]>;
} {
  const present = files instanceof Set ? files : new Set(files);
  const written: Array<[string, string]> = [];
  const logger = createRecordingLogger();

  const deps: ProxyEntryDeps = {
    selfDir: () => selfDir,
    env,
    requireResolve: (specifier) =>
      specifier === DAEMON_SPECIFIER ? resolved : null,
    exists: (path) => {
      onExists?.(path);
      return present.has(path);
    },
    readText: () => text,
    writeText: (path, contents) => {
      written.push([path, contents]);
      present.add(path);
    },
    mkdirp: (path) => {
      if (unwritable.includes(path)) {
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      }
    },
    rename: (from, to) => {
      present.delete(from);
      present.add(to);
    },
    relocateBases: () => ['/state/bin', '/tmp/staghorn-bin'],
    logger,
    version: '9.9.9',
  };
  return {
    resolver: createProxyEntryResolver(deps),
    logger,
    written,
  };
}

// Referenced so the constant stays honest if the daemon filename ever changes.
it('keeps the daemon filename in sync with the sibling lookup', () => {
  expect(DAEMON_FILENAME).toBe('proxy.mjs');
});
