import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const { version, name } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string; name: string };

// See src/version.ts for why both are injected rather than read at runtime.
const define = {
  __STAGHORN_VERSION__: JSON.stringify(version),
  __STAGHORN_PKG_NAME__: JSON.stringify(name),
};

// Two build passes with deliberately different shapes.
//
// Library entries are dual ESM+CJS: a consumer's dev tooling is frequently CJS
// (jest globalSetup, webpack.config.js), and `require(esm)` is only unflagged on
// Node 22.12+/20.19+. Shipping real CJS costs nothing here - zero dependencies,
// no ESM-only syntax anywhere in src - and removes a whole class of bug reports.
//
// Executed entries (the daemon and the CLI) are ESM-only and each bundled into a
// SINGLE self-contained file. That is not a size optimisation: `resolveProxyEntry`
// falls back to copying the daemon out of the package when the install layout
// makes it readable but not spawnable (Yarn PnP zips patch `fs`, not
// `child_process`). Copying is only correct if the daemon is one file with no
// relative siblings to follow.
//
// Explicit .mjs/.cjs extensions everywhere so module format comes from the file
// extension rather than a nearest-package.json lookup - which is what lets the
// daemon still run after being relocated to a directory that has no package.json
// at all (~/.dev-domains/bin, os.tmpdir()).
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      config: 'src/config/index.ts',
      testing: 'src/testing/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    shims: true, // import.meta.url <-> __dirname in both directions
    platform: 'node',
    target: 'node20',
    define,
    splitting: false,
    treeshake: true,
    sourcemap: true,
    clean: true,
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
  },
  {
    entry: { proxy: 'src/proxy/daemon.ts', cli: 'src/cli/bin.ts' },
    format: ['esm'],
    dts: false,
    bundle: true,
    platform: 'node',
    target: 'node20',
    define,
    splitting: false,
    // No sourcemap: the materialize fallback copies exactly one file, and a
    // dangling //# sourceMappingURL in a relocated copy is just noise in the log.
    sourcemap: false,
    outExtension: () => ({ js: '.mjs' }),
  },
]);
