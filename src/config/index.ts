// SPDX-License-Identifier: Apache-2.0
//
// Public config entrypoint: `staghorn/config`.

export type {
  DaemonConfig,
  Hooks,
  IdentityConfig,
  LabelledUrl,
  LogConfig,
  PortConfig,
  PortStrategy,
  ProxyConfig,
  RewriteConfig,
  ServiceConfig,
  StaghornConfig,
  StateConfig,
  UrlContext,
  UrlShape,
} from './types';

export {
  CONFIG_FILENAMES,
  DEFAULT_CONFIG,
  configFromEnv,
  loadConfig,
  type ConfigLayer,
  type ConfigSource,
  type LoadConfigOptions,
  type LoadedConfig,
} from './load';

import type { StaghornConfig } from './types';

/**
 * Identity function that types a config file.
 *
 * The only reason it exists is that the interesting parts of the config are
 * FUNCTIONS - `identity.slug.transform`, `url.buildUrls`, `hooks.onUrls`,
 * `state.isAlive`. Without a typed config file those are unusable in practice,
 * because nobody writes a callback correctly against a schema they cannot see.
 * JSON config is the subset of this without functions.
 */
export function defineConfig(config: StaghornConfig): StaghornConfig {
  return config;
}
