#!/usr/bin/env node
/*
 * Copyright 2026 Coralogix Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// SPDX-License-Identifier: Apache-2.0
//
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
// Control characters that must never appear in a source file. Tab, newline and
// carriage return are excluded; everything else in C0 plus DEL is a mistake.
//
// Built from char codes rather than written as an escape class on purpose: this rule
// exists because control bytes reached source files TWICE - an ESC/BEL pair in the
// terminal-link helper and a NUL used as a join separator, which made that whole file
// read as binary to grep and diff. Both arrived by writing an escape sequence that
// something along the way turned into the byte it denotes. Char codes cannot be
// mangled that way.
const FORBIDDEN_CONTROL_CODES = new Set([
  ...Array.from({ length: 32 }, (_, code) => code).filter(
    (code) => code !== 9 && code !== 10 && code !== 13,
  ),
  127,
]);

const RULES = [
  {
    name: 'control-character',
    test: (line) =>
      Array.from(line).some((char) =>
        FORBIDDEN_CONTROL_CODES.has(char.charCodeAt(0)),
      ),
    why: 'A control character in source. It makes the file read as binary to grep and diff, and it almost always arrived by accident. Build the character from String.fromCharCode() and give it a name instead.',
  },
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
    name: 'predecessor-name',
    // `devd` was the predecessor CLI and `dev-domains` the predecessor package.
    // Both reached the published .d.ts as TSDoc telling consumers to run commands
    // that do not exist, which no other rule here would ever catch.
    pattern: /\bdevd\b|\bdev-domains\b|cx-dev-domains|cx_dev_domains/,
    why: 'A name from the predecessor tool. The shipped binaries are `staghorn` and `stag`; anything else sends a consumer to a command or path that does not exist.',
  },
  {
    name: 'origin-repo-path',
    // `internal-host` needs a dotted hostname, so `github.com/coralogix/<repo>` in a
    // link slips past it. That is exactly how five dead CHANGELOG links survived.
    //
    // Links to THIS repo are the point of a README, so they are excluded here rather
    // than in the allowlist: an allowlist entry per file would grow without bound as
    // docs pages are added, and this file's own rule is that a growing allowlist means
    // the pattern is wrong. The delimiter class after the name is what keeps
    // `coralogix/staghorn-old` - the pre-extraction repo - still caught.
    pattern:
      /coralogix\/internal-|github\.com\/coralogix\/(?!staghorn(?:[/#?).\s"'>]|$))/,
    why: 'A link into another Coralogix repository. Public readers cannot follow it, and an `internal-` repo does not resolve at all. Link this package’s own public repo or nothing.',
  },
  {
    name: 'private-scope',
    // Any mention, not just an import specifier. A narrower import-only form let a
    // bare string constant and a lockfile `name` field through, both of which are
    // exactly as broken for a consumer as an import would be.
    pattern: /@cx\//,
    why: 'The private @cx scope does not resolve outside the company, whether it is imported, spawned, or printed in a message.',
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
      // A rule matches either by regex or by predicate - the control-character rule
      // needs the latter, because expressing it as a regex would mean writing the very
      // escape sequences that caused the problem.
      const matched = rule.test ? rule.test(line) : rule.pattern.test(line);
      if (!matched) {
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
