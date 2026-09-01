#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Proves the packed tarball actually works when INSTALLED, per package manager.
//
// Unit tests cover the daemon-path resolver with staged fixtures, which is necessary
// and not sufficient: what varies between package managers is the real on-disk layout,
// and no fixture can be wrong in the same way a real install is. The case that matters
// most is Yarn PnP with zip-compressed dependencies, where `fs` is patched but
// `child_process` is not - so the daemon is readable and NOT spawnable, and the
// resolver has to notice and copy it out.
//
// Run with the CWD set to a directory that has @cx/staghorn installed.
//
// Everything is resolved from the FIXTURE, never by bare specifier. Node lets a
// package import itself by name through its own `exports` field, so a bare
// `import('@cx/staghorn')` inside this repo silently resolves to the SOURCE tree - the
// first version of this script did exactly that and "passed" while testing nothing.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@cx/staghorn';
const fixture = process.cwd();
const expectRelocated = process.argv.includes('--expect-relocated');
const failures = [];

// Anchored on the fixture's own package.json, so resolution follows the fixture's
// installed tree (and, under PnP, Yarn's loader) rather than this script's location.
const fixtureRequire = createRequire(join(fixture, 'package.json'));

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}: ${err.message}`);
    return false;
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}: ${err.message}`);
    return false;
  }
}

// 1. Find the INSTALLED package. `./package.json` is in the exports map precisely so
//    this is possible without guessing at a directory layout.
let manifestPath = null;
let packageDir = null;
let manifest = null;
check('installed package is resolvable', () => {
  manifestPath = fixtureRequire.resolve(`${PACKAGE}/package.json`);
  packageDir = dirname(manifestPath);
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (resolvePath(packageDir) === resolvePath(import.meta.dirname, '..')) {
    throw new Error('resolved the source tree, not an install - self-reference leak');
  }
  return `${manifest.name}@${manifest.version}`;
});

// 2. The ESM entry, reached through the exports map of the installed copy.
let esm = null;
await checkAsync('ESM entry imports', async () => {
  if (!packageDir) throw new Error('skipped: package not resolved');
  const target = manifest.exports?.['.']?.import?.default;
  if (!target) throw new Error('exports["."].import.default is missing');
  esm = await import(pathToFileURL(join(packageDir, target)).href);
  for (const name of ['createDevDomain', 'createProxy', 'ensureProxy', 'createProxyEntryResolver']) {
    if (typeof esm[name] !== 'function') throw new Error(`missing export ${name}`);
  }
  return `${Object.keys(esm).length} exports`;
});

// 3. The CJS entry. Consumers' dev tooling is frequently CJS (jest globalSetup,
//    webpack.config.js), and `require(esm)` is only unflagged on newer Node.
check('CJS entry requires', () => {
  if (!packageDir) throw new Error('skipped: package not resolved');
  const target = manifest.exports?.['.']?.require?.default;
  if (!target) throw new Error('exports["."].require.default is missing');
  const cjs = fixtureRequire(join(packageDir, target));
  if (typeof cjs.createDevDomain !== 'function') {
    throw new Error('createDevDomain missing from the CJS build');
  }
  return 'createDevDomain present';
});

// 4. Subpath export.
check('subpath ./config resolves', () => {
  const path = fixtureRequire.resolve(`${PACKAGE}/config`);
  if (!path) throw new Error('unresolvable');
  return 'resolvable';
});

// 5. THE point of this script: the daemon must be locatable AND spawnable from here.
let entry = null;
check('daemon entry resolves', () => {
  if (!esm) throw new Error('skipped: ESM entry unavailable');
  entry = esm.createProxyEntryResolver().resolve();
  if (entry === null) throw new Error('resolver returned null - daemon not located');
  return entry;
});

check('daemon entry is a real file', () => {
  if (!entry) throw new Error('skipped: no entry');
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`${entry} is not a file`);
  }
  return `${statSync(entry).size} bytes`;
});

check('daemon entry is spawnable, not zip-mounted', () => {
  if (!entry) throw new Error('skipped: no entry');
  // A zip-mounted path is readable but not executable, so returning one would mean
  // every spawn fails at runtime with a confusing ENOENT.
  if (esm.isZipMounted(entry)) {
    throw new Error(`${entry} is inside a zip and cannot be spawned`);
  }
  return 'spawnable';
});

// 6. Under PnP the resolver must have COPIED the daemon out. The check above proves it
//    is not in a zip; this proves the copy is where we intended, rather than the whole
//    thing having silently fallen back to something else.
if (expectRelocated) {
  check('daemon was relocated out of the zip', () => {
    if (!entry) throw new Error('skipped: no entry');
    if (!entry.includes('staghorn-bin') && !entry.includes(esm.relocatedDaemonDir())) {
      throw new Error(`expected a relocated copy, got ${entry}`);
    }
    return entry;
  });
}

// 7. The version the code reports matches the installed manifest.
check('reported version matches the manifest', () => {
  if (!esm || !manifest) throw new Error('skipped');
  if (manifest.version !== esm.VERSION) {
    throw new Error(`manifest ${manifest.version} vs VERSION ${esm.VERSION}`);
  }
  return manifest.version;
});

if (failures.length > 0) {
  console.error(`\nsmoke-install: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nsmoke-install: all good');
