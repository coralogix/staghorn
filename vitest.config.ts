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
