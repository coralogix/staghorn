// SPDX-License-Identifier: Apache-2.0
//
// Public entrypoint: `staghorn`.
//
// Files inside src/ import their siblings relatively, never through this barrel, so
// the daemon and CLI bundles do not drag the whole package in behind them.

export {
  createDevDomain,
  resolveDevDomain,
  type CreateDevDomainOptions,
  type DevDomain,
  type DevDomainDeps,
  type DevDomainPlan,
} from './create-dev-domain';

export {
  ensureProxy,
  type EnsureProxyDeps,
  type EnsureProxyOptions,
  type EnsuredProxy,
  type FallbackReason,
  type ProxyMode,
} from './ensure-proxy';

export {
  createProxy,
  type ProxyDeps,
  type ProxyHandle,
  type ProxyOptions,
} from './proxy/create-proxy';

export {
  holdLease,
  probeProxy,
  requestShutdown,
  type ProxyLease,
} from './control-client';

export {
  DEFAULT_TLD,
  MAX_HOSTNAME_LENGTH,
  MAX_LABEL_LENGTH,
  buildHost,
  buildRouteKey,
  isControlHost,
  labelsUnderTld,
  matchHost,
  routeKeyLabels,
  splitHostHeader,
  type HostMatch,
  type RouteParts,
} from './host';

export {
  branchLabelBudget,
  branchToLabel,
  disambiguateRouteKey,
  projectToLabel,
  slugLabel,
} from './identity/slug';

export {
  nearestPackageName,
  readRepoContext,
  type RepoContext,
  type RepoContextDeps,
} from './identity/context';

export {
  resolveIdentity,
  type BranchSource,
  type IdentityOverrides,
  type ProjectSource,
  type ResolvedIdentity,
} from './identity/resolve-identity';

export {
  PORT_MAX,
  PORT_MIN,
  nextPortCandidate,
  preferredPort,
} from './ports/hash';
export { isPortFree, pickPort, type PickPortOptions } from './ports/probe';

export {
  createDaemonInfoStore,
  isCurrentUid,
  isOwnedByCurrentUser,
  liveDaemonInfo,
  type DaemonInfo,
  type DaemonInfoStore,
} from './state/daemon-info';

export {
  ROUTE_SCHEMA_VERSION,
  createFileRouteStore,
  isPidAlive,
  resolveWatchStrategy,
  type DevRoute,
  type PruneResult,
  type RouteSnapshot,
  type RouteStore,
  type RouteStoreOptions,
  type WatchStrategy,
} from './state/routes';

export {
  createLeaseTracker,
  LEASE_BOOT_GRACE_MS,
  LEASE_LINGER_MS,
  MAX_LEASES,
  type LeaseConnection,
  type LeaseTracker,
} from './proxy/leases';

export {
  CONTROL_HEADER,
  CONTROL_PREFIX,
  DEFAULT_SHARED_PORT,
  DEFAULT_WILDCARD_PORT,
  LEASE_PATH,
  PROTOCOL_VERSION,
  PROXY_NAME,
  SHUTDOWN_PATH,
  STATUS_PATH,
  isLoopbackAddress,
  isProtocolCompatible,
  type ProbeOutcome,
  type ProxyStatus,
} from './protocol';

export {
  createProxyEntryResolver,
  isPnpActive,
  isZipMounted,
  nodeBinary,
  proxyEntryResolver,
  type ProxyEntryDeps,
  type ProxyEntryResolver,
} from './resolve-proxy-entry';

export { renderBanner, terminalLink, type BannerInput } from './banner';

export {
  createLogger,
  silentLogger,
  type LogLevel,
  type LogRecord,
  type Logger,
} from './log';

export { systemClock, type Clock, type Timers } from './clock';

export {
  daemonInfoPath,
  proxyLogPath,
  relocatedDaemonDir,
  routePath,
  routesDir,
  stateDir,
} from './paths';

export { PACKAGE_NAME, VERSION } from './version';

// The config surface is also its own subpath (`staghorn/config`) for consumers who
// only want to type a config file; re-exported here so the main entry is complete.
export {
  CONFIG_FILENAMES,
  DEFAULT_CONFIG,
  configFromEnv,
  defineConfig,
  loadConfig,
  type ConfigLayer,
  type ConfigSource,
  type LoadConfigOptions,
  type LoadedConfig,
  type StaghornConfig,
  type UrlContext,
  type UrlShape,
} from './config/index';
