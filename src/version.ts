// The package version, injected at build time by tsup's `define`.
//
// Compile-time rather than a runtime read of package.json, because the daemon is a
// single bundled file that may be COPIED out of the package (see
// resolve-proxy-entry.ts). A relocated copy has no package.json anywhere near it,
// so anything resolved relative to the file would fail exactly in the fallback
// case that exists to be reliable.
declare const __STAGHORN_VERSION__: string | undefined;
declare const __STAGHORN_PKG_NAME__: string | undefined;

// `typeof` on an undeclared identifier is safe in JS, so this is also correct in
// unbundled contexts (vitest, `tsx src/...`), where it falls back.
export const VERSION: string =
  typeof __STAGHORN_VERSION__ === 'string'
    ? __STAGHORN_VERSION__
    : '0.0.0-dev';

/**
 * The package's own name, injected the same way.
 *
 * Derived rather than written down because the name is scheduled to change: the
 * package ships to the internal registry first and is renamed when it goes
 * public. Anything that hardcoded a name would keep resolving - by falling
 * silently through to a slower branch - which is the worst possible failure for
 * the daemon lookup. See resolve-proxy-entry.ts.
 */
export const PACKAGE_NAME: string =
  typeof __STAGHORN_PKG_NAME__ === 'string'
    ? __STAGHORN_PKG_NAME__
    : 'staghorn';
