// Config discovery, layering, and provenance.
//
// Layers, low to high:
//
//   defaults
//     < user config      $XDG_CONFIG_HOME/staghorn/config.*
//     < project config   staghorn.config.* | package.json#staghorn
//     < env              STAGHORN_*
//     < CLI flags
//     < programmatic     options passed to createDevDomain()
//     < user `overrides` deliberately last - see types.ts
//
// Every merged key records WHERE it came from. That is not a luxury: most support
// questions about a layered config are "why is this value what it is", and
// `devd config --print` answers them without anyone having to reason about six
// layers.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorMessage, isEnoent } from '../errors';
import { DEFAULT_TLD } from '../host';
import { silentLogger, type Logger } from '../log';
import type { StaghornConfig } from './types';

/** Filenames looked for, in order, in each directory walked. */
export const CONFIG_FILENAMES: readonly string[] = [
  'staghorn.config.ts',
  'staghorn.config.mts',
  'staghorn.config.mjs',
  'staghorn.config.js',
  'staghorn.config.cjs',
  'staghorn.config.json',
  '.staghornrc.json',
];

export type ConfigLayer =
  | 'default'
  | 'user'
  | 'project'
  | 'env'
  | 'flags'
  | 'programmatic'
  | 'user-overrides';

export interface ConfigSource {
  readonly layer: ConfigLayer;
  /** File the value came from, when it came from one. */
  readonly file?: string;
}

/**
 * A config supplied programmatically or from flags.
 *
 * Callers assemble these from optional sources (`{ tld: argv.tld }`), so an
 * explicit `undefined` is routine and has to mean "not set" rather than "erase the
 * layer below". `exactOptionalPropertyTypes` would otherwise reject the ordinary
 * call site.
 */
export type ConfigInput = {
  [K in keyof StaghornConfig]?: StaghornConfig[K] | undefined;
};

export interface LoadedConfig {
  readonly config: StaghornConfig;
  /** Dotted key path -> where the winning value came from. */
  readonly provenance: ReadonlyMap<string, ConfigSource>;
  /** Config files that were read, in layering order. */
  readonly files: readonly string[];
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Values from CLI flags. */
  readonly flags?: ConfigInput;
  /** Values passed directly to the API. */
  readonly programmatic?: ConfigInput;
  /** Stop walking up here. Defaults to the filesystem root. */
  readonly stopAt?: string;
  readonly logger?: Logger;
  readonly readConfigFile?: (path: string) => Promise<StaghornConfig | null>;
  readonly fileExists?: (path: string) => Promise<boolean>;
}

export const DEFAULT_CONFIG: StaghornConfig = {
  enabled: true,
  activate: 'always',
  tld: DEFAULT_TLD,
  strict: false,
};

export async function loadConfig({
  cwd = process.cwd(),
  env = process.env,
  flags = {},
  programmatic = {},
  stopAt,
  logger = silentLogger,
  readConfigFile = importConfigFile,
  fileExists,
}: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const userConfig = await findUserConfig({ env, readConfigFile, fileExists, logger });
  const projectConfig = await findProjectConfig({
    cwd,
    stopAt,
    readConfigFile,
    fileExists,
    logger,
  });

  const layers: Array<{ layer: ConfigLayer; file?: string; value: ConfigInput }> = [
    { layer: 'default', value: DEFAULT_CONFIG },
  ];
  if (userConfig) {
    layers.push({ layer: 'user', file: userConfig.file, value: stripOverrides(userConfig.config) });
  }
  if (projectConfig) {
    layers.push({
      layer: 'project',
      file: projectConfig.file,
      // `overrides` in a PROJECT config is meaningless - it would just be a second
      // copy of the same layer - so it is dropped rather than silently honoured.
      value: stripOverrides(projectConfig.config),
    });
  }
  layers.push({ layer: 'env', value: configFromEnv(env) });
  layers.push({ layer: 'flags', value: flags });
  layers.push({ layer: 'programmatic', value: programmatic });
  if (userConfig?.config.overrides) {
    layers.push({
      layer: 'user-overrides',
      file: userConfig.file,
      value: userConfig.config.overrides,
    });
  }

  const provenance = new Map<string, ConfigSource>();
  const config = layers.reduce<StaghornConfig>(
    (merged, { layer, file, value }) =>
      mergeLayer(merged, value, layer, file, '', provenance),
    {},
  );

  return {
    config,
    provenance,
    files: layers.flatMap(({ file }) => (file ? [file] : [])),
  };
}

/**
 * Deep-merge one layer over the accumulator, recording provenance per leaf.
 *
 * Objects merge, arrays and functions replace wholesale. Replacing arrays is the
 * less surprising of the two options: a consumer overriding `probeHosts` means
 * "these hosts", not "these as well as the defaults".
 */
function mergeLayer(
  base: StaghornConfig,
  layerValue: ConfigInput,
  layer: ConfigLayer,
  file: string | undefined,
  prefix: string,
  provenance: Map<string, ConfigSource>,
): StaghornConfig {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layerValue)) {
    if (value === undefined || key === 'overrides') {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    const existing = merged[key];
    if (isPlainObject(value)) {
      // Recurse even when nothing is there yet, so provenance is recorded per
      // LEAF rather than per branch. Otherwise the first layer to introduce `log`
      // owns the whole subtree in `config --print`, and the question people
      // actually ask - "why is log.level debug" - goes unanswered.
      merged[key] = mergeLayer(
        isPlainObject(existing) ? existing : {},
        value,
        layer,
        file,
        path,
        provenance,
      );
      continue;
    }
    merged[key] = value;
    provenance.set(path, file === undefined ? { layer } : { layer, file });
  }
  return merged;
}

/**
 * Environment projection.
 *
 * A flat, mechanical mapping of the same keys rather than a set of bespoke names -
 * so there is one thing to learn, and `STAGHORN_TLD` is guessable from `tld`.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): StaghornConfig {
  const config: Record<string, unknown> = {};
  const disable = env['STAGHORN_DISABLE']?.trim();
  if (disable === '1' || disable === 'true') {
    config['enabled'] = false;
  }
  const tld = env['STAGHORN_TLD']?.trim();
  if (tld) {
    config['tld'] = tld;
  }
  const mode = env['STAGHORN_MODE']?.trim();
  if (mode === 'auto' || mode === 'wildcard' || mode === 'sharedPort' || mode === 'direct') {
    config['proxy'] = { mode };
  }
  const stateDir = env['STAGHORN_STATE_DIR']?.trim();
  if (stateDir) {
    config['state'] = { dir: stateDir };
  }
  const level = env['STAGHORN_LOG']?.trim();
  if (
    level === 'silent' ||
    level === 'error' ||
    level === 'warn' ||
    level === 'info' ||
    level === 'debug'
  ) {
    config['log'] = { level };
  }
  const fixedPort = env['STAGHORN_PORT']?.trim();
  if (fixedPort && /^\d+$/.test(fixedPort)) {
    config['ports'] = { strategy: 'fixed', fixed: Number.parseInt(fixedPort, 10) };
  }
  const project = env['STAGHORN_PROJECT']?.trim();
  if (project) {
    config['identity'] = { project: project === 'false' ? false : project };
  }
  return config;
}

async function findUserConfig({
  env,
  readConfigFile,
  fileExists,
  logger,
}: {
  env: NodeJS.ProcessEnv;
  readConfigFile: (path: string) => Promise<StaghornConfig | null>;
  fileExists: ((path: string) => Promise<boolean>) | undefined;
  logger: Logger;
}): Promise<{ file: string; config: StaghornConfig } | null> {
  const base = env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return firstConfigIn(join(base, 'staghorn'), {
    readConfigFile,
    fileExists,
    logger,
  });
}

async function findProjectConfig({
  cwd,
  stopAt,
  readConfigFile,
  fileExists,
  logger,
}: {
  cwd: string;
  stopAt: string | undefined;
  readConfigFile: (path: string) => Promise<StaghornConfig | null>;
  fileExists: ((path: string) => Promise<boolean>) | undefined;
  logger: Logger;
}): Promise<{ file: string; config: StaghornConfig } | null> {
  const boundary = stopAt ? resolve(stopAt) : parse(resolve(cwd)).root;
  let directory = resolve(cwd);
  for (;;) {
    const found = await firstConfigIn(directory, { readConfigFile, fileExists, logger });
    if (found) {
      return found;
    }
    const fromPackage = await packageJsonConfig(directory, logger);
    if (fromPackage) {
      return fromPackage;
    }
    if (directory === boundary || directory === dirname(directory)) {
      return null;
    }
    directory = dirname(directory);
  }
}

async function firstConfigIn(
  directory: string,
  {
    readConfigFile,
    fileExists,
    logger,
  }: {
    readConfigFile: (path: string) => Promise<StaghornConfig | null>;
    fileExists: ((path: string) => Promise<boolean>) | undefined;
    logger: Logger;
  },
): Promise<{ file: string; config: StaghornConfig } | null> {
  for (const filename of CONFIG_FILENAMES) {
    const file = join(directory, filename);
    if (fileExists && !(await fileExists(file))) {
      continue;
    }
    try {
      const config = await readConfigFile(file);
      if (config) {
        return { file, config };
      }
    } catch (err) {
      // A config file that exists and cannot be loaded is a real problem the
      // developer must see - unlike one that simply is not there.
      logger.warn(`could not load ${file}: ${errorMessage(err)}`);
    }
  }
  return null;
}

async function packageJsonConfig(
  directory: string,
  logger: Logger,
): Promise<{ file: string; config: StaghornConfig } | null> {
  const file = join(directory, 'package.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (!isEnoent(err)) {
      logger.debug(`could not read ${file}: ${errorMessage(err)}`);
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'staghorn' in parsed &&
      isPlainObject(parsed.staghorn)
    ) {
      return { file, config: parsed.staghorn };
    }
  } catch {
    // Not ours to report.
  }
  return null;
}

/**
 * Load a config file.
 *
 * `.ts` is imported only if the running Node can strip types natively. There is no
 * bundled transpiler on purpose: adding one would end the package's zero-dependency
 * property, which is worth more than `.ts` config on old Node. The error names the
 * file and the fix rather than failing obscurely.
 */
async function importConfigFile(path: string): Promise<StaghornConfig | null> {
  if (path.endsWith('.json')) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      return isPlainObject(parsed) ? parsed : null;
    } catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
  }
  try {
    const imported: unknown = await import(pathToFileURL(path).href);
    return extractConfig(imported);
  } catch (err) {
    if (isModuleNotFound(err, path)) {
      return null;
    }
    if (path.endsWith('.ts') || path.endsWith('.mts')) {
      throw new Error(
        `${path} could not be loaded. This Node build cannot import TypeScript directly; ` +
          `rename it to staghorn.config.mjs, or run Node with --experimental-strip-types. ` +
          `(${errorMessage(err)})`,
      );
    }
    throw err;
  }
}

function extractConfig(imported: unknown): StaghornConfig | null {
  if (!isPlainObject(imported)) {
    return null;
  }
  const value = 'default' in imported ? imported.default : imported;
  return isPlainObject(value) ? value : null;
}

function isModuleNotFound(err: unknown, path: string): boolean {
  if (isEnoent(err)) {
    return true;
  }
  const message = errorMessage(err);
  return (
    message.includes('ERR_MODULE_NOT_FOUND') ||
    (message.includes('Cannot find module') && message.includes(path))
  );
}

function stripOverrides(config: StaghornConfig): StaghornConfig {
  const { overrides, ...rest } = config;
  void overrides;
  return rest;
}

/**
 * A mergeable object, meaning a literal - NOT any object.
 *
 * The prototype check is what makes this correct: a RegExp, Date or Map is
 * `typeof 'object'` and not an array, so a laxer guard would deep-merge them
 * key-by-key into a broken half-object. `ports.discovery.fromStdout` is a RegExp,
 * so this is a live case, not a hypothetical.
 */
function isPlainObject(value: unknown): value is Record<string, never> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
