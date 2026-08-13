#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The only place that touches the real process. Everything else in the CLI is
// `run(io)`, a function of its arguments - which is what makes every surface
// snapshot-testable instead of requiring a subprocess.

import { run } from './run';

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  isTty: process.stdout.isTTY ?? false,
});
