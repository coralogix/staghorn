#!/usr/bin/env node
// The gate that has to be green before this repository can be made public.
//
// It runs from day one, on every CI run, rather than being saved for the
// open-source flip. Scrubbing a repository once at the end means auditing months of
// history under time pressure; checking continuously means the history is simply
// never dirty. The compliance review then has something to confirm rather than
// something to fix.
//
// This is a lint, not a security boundary. It catches the material that plausibly
// travels with extracted code - internal hostnames, ticket keys, credentials, and
// commands that only make sense in the origin monorepo. Secret scanning and push
// protection on the repository are the real defence.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location, never process.cwd(): the script must
// behave identically whether it is run from the repo root, from scripts/, or by CI.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.changeset',
]);

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);

/**
 * Each rule explains itself, because a failure a developer cannot interpret gets
 * worked around rather than fixed.
 */
const RULES = [
  {
    name: 'uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    why: 'A UUID here is most likely a token or an account id. The tool this was extracted from carried a live reCAPTCHA-bypass token in its URL builder; that file was deliberately left behind, and nothing like it should arrive by another route.',
  },
  {
    name: 'internal-host',
    pattern: /\b[\w.-]*\.(?:coralogix\.(?:com|net|us|in)|cgx\.[\w.-]+)\b/i,
    why: 'Internal hostnames should not appear in a package that is going public. The registry URL in package.json publishConfig is the one allowed exception and is listed below.',
  },
  {
    name: 'ticket-key',
    pattern: /\b(?:CX|BUGV2|APM|EXP|FEII|FEI)-\d{2,6}\b/,
    why: 'Jira keys are meaningless outside the company and date the code. Describe the change instead of pointing at a ticket.',
  },
  {
    name: 'origin-repo-command',
    pattern: /pnpm run worktrees:|pnpm nx |tools\/dev-domains/,
    why: 'A command or path from the origin monorepo. User-facing text must name this package’s own CLI, which is also the only thing a consumer could actually run.',
  },
  {
    name: 'private-scope-import',
    // Matches an @cx/... import specifier, not the package's own name field.
    pattern: /from\s+['"]@cx\/|require\(['"]@cx\//,
    why: 'Importing from the private @cx scope would make this package unusable outside the company.',
  },
  {
    name: 'credential',
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/,
    why: 'A credential. Rotate it, then remove it.',
  },
];

/**
 * Lines that are allowed to match, with the reason.
 *
 * Kept deliberately small and specific. A growing allowlist means the rules are
 * wrong and should be narrowed instead.
 */
const ALLOWED = [
  {
    file: 'package.json',
    contains: 'cgx.jfrog.io',
    why: 'the internal registry, for the internal publishing phase; removed at the open-source flip',
  },
  {
    file: '.github/workflows/release.yml',
    contains: 'cgx.jfrog.io',
    why: 'same, in the internal-phase publish step',
  },
  {
    file: 'scripts/scrub-check.mjs',
    contains: '',
    why: 'this file necessarily contains the patterns it searches for',
  },
];

const findings = [];

for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = relative(ROOT, file);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) {
        continue;
      }
      if (isAllowed(rel, line)) {
        continue;
      }
      findings.push({ rel, line: index + 1, rule, text: line.trim().slice(0, 160) });
    }
  });
}

if (findings.length === 0) {
  console.log('scrub-check: clean');
  process.exit(0);
}

console.error(`scrub-check: ${findings.length} finding(s)\n`);
for (const { rel, line, rule, text } of findings) {
  console.error(`  ${rel}:${line}  [${rule.name}]`);
  console.error(`    ${text}`);
  console.error(`    why: ${rule.why}\n`);
}
process.exit(1);

function isAllowed(rel, line) {
  return ALLOWED.some(
    (entry) =>
      rel === entry.file && (entry.contains === '' || line.includes(entry.contains)),
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (SCANNED_EXTENSIONS.has(extname(entry)) || entry === 'NOTICE') {
      yield full;
    }
  }
}
