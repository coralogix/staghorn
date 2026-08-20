// The programmatic API: everything above wired into one call.
//
//   config -> repo context -> identity -> route key -> proxy ladder -> port
//          -> register -> lease -> URLs -> cleanup on exit
//
// Two entry points, because callers want different things. `resolveDevDomain`
// answers "what WOULD happen" with no side effects at all - no registry write, no
// spawn, no lease - so a dev script can decide before committing. `createDevDomain`
// does it.
//
// Neither ever throws unless `strict` is set. A tool that can take a developer's
// dev server down with it has negative value, however convenient it is when it works.

import { errorMessage } from './errors';
import { DEFAULT_TLD, buildHost, buildRouteKey } from './host';
import { readRepoContext, type RepoContext } from './identity/context';
import { disambiguateRouteKey } from './identity/slug';
import { resolveIdentity } from './identity/resolve-identity';
import { createLogger, type Logger } from './log';
import { pickPort } from './ports/probe';
import { PORT_MAX, PORT_MIN } from './ports/hash';
import { ensureProxy, type FallbackReason, type ProxyMode } from './ensure-proxy';
import { holdLease, type ProxyLease } from './control-client';
import { createFileRouteStore, type RouteSnapshot, type RouteStore } from './state/routes';
import { renderBanner } from './banner';
import { loadConfig, type ConfigInput } from './config/load';
import type { LabelledUrl, StaghornConfig, UrlContext } from './config/types';

export interface CreateDevDomainOptions extends ConfigInput {
  readonly cwd?: string;
  /** Which entry in `services` this dev server is. */
  readonly service?: string;
  /** Skip the banner; the caller prints its own. */
  readonly quiet?: boolean;
}

export interface DevDomain {
  readonly routeKey: string;
  /** The registered host, no prefix: `feature-x.myapp.localhost`. */
  readonly host: string;
  /** The host including `url.primary` - what gets printed. */
  readonly primaryHost: string;
  readonly origin: string;
  readonly directOrigin: string;
  /** The dev server's own port. */
  readonly port: number;
  /** The daemon's port, or null when portless. */
  readonly proxyPort: number | null;
  readonly mode: ProxyMode;
  readonly reason: FallbackReason;
  readonly urls: readonly LabelledUrl[];
  readonly identity: RepoContext;
  /**
   * The resolved labels that make up the route key, after slugging and any
   * collision suffixing.
   *
   * Exposed because a caller that wants to DISPLAY them otherwise has to re-derive
   * them, and the obvious guesses are both wrong: `identity.packageName` is the raw
   * package name rather than the configured project label, and `routeKey` is all
   * three labels joined. The CLI banner got both wrong before this existed.
   */
  readonly labels: {
    readonly branch: string;
    readonly project: string | null;
    readonly service: string | null;
  };
  /** Environment to pass to a child dev server. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Correct the port after the dev server actually bound one.
   *
   * First-class rather than an afterthought: with the `discover` strategy the real
   * port is not known until the child says so, and a dev server that drifts to
   * port+1 would otherwise leave the registry pointing at nothing. The predecessor
   * had exactly that silent desync.
   */
  setPort(port: number): Promise<void>;
  printBanner(): void;
  /** Deregister and drop the lease. Idempotent; also wired to process exit. */
  release(): Promise<void>;
}

export interface DevDomainPlan {
  readonly eligible: boolean;
  readonly reason: FallbackReason | 'not-activated';
  readonly identity: RepoContext;
  readonly routeKey: string | null;
  readonly config: StaghornConfig;
  activate(): Promise<DevDomain>;
}

export interface DevDomainDeps {
  readonly routes?: RouteStore;
  readonly logger?: Logger;
  readonly ensure?: typeof ensureProxy;
  readonly lease?: typeof holdLease;
  readonly context?: RepoContext;
  readonly print?: (text: string) => void;
}

/** Plan without touching anything. */
export async function resolveDevDomain(
  options: CreateDevDomainOptions = {},
  deps: DevDomainDeps = {},
): Promise<DevDomainPlan> {
  const { cwd = process.cwd(), service, quiet, ...configInput } = options;
  const { config } = await loadConfig({ cwd, programmatic: configInput });
  const logger =
    deps.logger ??
    createLogger({
      ...(config.log?.level ? { level: config.log.level } : {}),
      ...(config.log?.sink ? { sink: config.log.sink } : {}),
    });
  const context = deps.context ?? (await readRepoContext(cwd));

  if (!activated(config, context)) {
    return {
      eligible: false,
      reason: 'not-activated',
      identity: context,
      routeKey: null,
      config,
      activate: () =>
        Promise.reject(new Error('staghorn is not activated for this directory')),
    };
  }

  const routeKey = plannedRouteKey(config, context, service);
  return {
    eligible: config.enabled !== false,
    reason: config.enabled === false ? 'disabled' : 'ok',
    identity: context,
    routeKey,
    config,
    activate: () =>
      createDevDomain(options, { ...deps, logger, context }),
  };
}

export async function createDevDomain(
  options: CreateDevDomainOptions = {},
  deps: DevDomainDeps = {},
): Promise<DevDomain> {
  const { cwd = process.cwd(), service, quiet = false, ...configInput } = options;
  const { config } = await loadConfig({ cwd, programmatic: configInput });
  const logger =
    deps.logger ??
    createLogger({
      ...(config.log?.level ? { level: config.log.level } : {}),
      ...(config.log?.sink ? { sink: config.log.sink } : {}),
    });
  const {
    routes = createFileRouteStore({
      logger,
      ...(config.state?.isAlive ? { isAlive: config.state.isAlive } : {}),
    }),
    ensure = ensureProxy,
    lease: takeLease = holdLease,
    print = (text: string) => process.stderr.write(`${text}\n`),
  } = deps;

  const tld = config.tld ?? DEFAULT_TLD;
  const context = deps.context ?? (await readRepoContext(cwd));

  // Claim a route key, suffixing only if another checkout of the SAME project holds
  // the same branch. With the project label present this is rare, which is the point.
  const snapshot = await routes.read();
  const identity = resolveIdentity(context, identityOverrides(config, tld, service));
  const wanted = {
    branch: identity.branch,
    project: identity.project,
    service: identity.service,
  };
  const claimed =
    config.identity?.disambiguate === false
      ? { routeKey: buildRouteKey(wanted), parts: wanted }
      : disambiguateRouteKey(wanted, (key) => {
          const owner = snapshot.get(key);
          // A re-serve of this same checkout reclaims its own key.
          return !owner || owner.checkoutPath === (context.worktreePath ?? cwd);
        });
  const routeKey = claimed.routeKey;

  // The ladder. Never throws; degrades with one explanatory line.
  const proxy = await ensure(
    {
      enabled: config.enabled !== false,
      ...(config.proxy?.mode ? { mode: config.proxy.mode } : {}),
      ...(config.proxy?.wildcardPort === undefined
        ? {}
        : { wildcardPort: config.proxy.wildcardPort }),
      ...(config.proxy?.sharedPort === undefined
        ? {}
        : { sharedPort: config.proxy.sharedPort }),
      ...(config.daemon?.entry ? { proxyEntry: config.daemon.entry } : {}),
    },
    { logger },
  );

  const port = await resolvePort(config, routeKey, snapshot, context.worktreePath ?? cwd);
  let currentPort = port;
  let currentLease: ProxyLease | null = null;

  const buildUrlContext = (): UrlContext => {
    const host = buildHost({ routeKey, tld, port: proxy.proxyPort });
    const primary = config.url?.primary ?? null;
    const primaryHost = buildHost({
      routeKey,
      tld,
      port: proxy.proxyPort,
      ...(primary ? { prefix: primary } : {}),
    });
    return {
      routeKey,
      host,
      primaryHost,
      origin: `http://${primaryHost}`,
      scheme: 'http',
      proxyPort: proxy.proxyPort,
      port: currentPort,
      directOrigin: `http://localhost:${currentPort}`,
      mode: proxy.mode,
      service: identity.service,
      identity: context,
    };
  };

  const register = async (): Promise<void> => {
    await routes.upsert({
      routeKey,
      port: currentPort,
      pid: process.pid,
      checkoutPath: context.worktreePath ?? cwd,
      branch: claimed.parts.branch,
      project: claimed.parts.project ?? null,
      service: claimed.parts.service ?? null,
      ...(config.identity?.meta ? { meta: config.identity.meta(context) } : {}),
    });
  };

  // Only register and lease when a proxy will actually route. In direct mode there
  // is nothing to route to and nothing to keep alive.
  if (proxy.mode !== 'direct') {
    await register();
    if (proxy.proxyPort !== null || proxy.mode === 'wildcard') {
      const leasePort = proxy.proxyPort ?? proxy.status?.port ?? null;
      if (leasePort !== null) {
        currentLease = await takeLease(leasePort, routeKey, { logger });
        if (!currentLease.held) {
          logger.debug('no lease held; the daemon may exit while this server runs');
        }
      }
    }
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    currentLease?.release();
    try {
      await routes.remove(routeKey, process.pid);
    } catch (err) {
      logger.debug('could not deregister route', { error: errorMessage(err) });
    }
  };

  // Sync teardown on the paths that cannot await. Ownership-checked, so a dying
  // server can never delete the route a newer one just claimed for the same host.
  const cleanupSync = (): void => {
    if (released) {
      return;
    }
    released = true;
    currentLease?.release();
    try {
      routes.removeSync(routeKey, process.pid);
    } catch {
      // Exit-time best effort; the daemon prunes dead routes anyway.
    }
  };
  process.once('exit', cleanupSync);
  process.once('SIGINT', () => {
    cleanupSync();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanupSync();
    process.exit(143);
  });

  const urlsFor = (urlContext: UrlContext): readonly LabelledUrl[] => {
    if (config.url?.buildUrls) {
      return config.url.buildUrls(urlContext);
    }
    const base =
      proxy.mode === 'direct' ? urlContext.directOrigin : urlContext.origin;
    const path = config.url?.entryPath ?? '/';
    const query = renderQuery(config.url?.query);
    return [{ label: 'url', url: `${base}${path === '/' ? '' : path}${query}` }];
  };

  const domain: DevDomain = {
    routeKey,
    get host() {
      return buildUrlContext().host;
    },
    get primaryHost() {
      return buildUrlContext().primaryHost;
    },
    get origin() {
      return buildUrlContext().origin;
    },
    get directOrigin() {
      return buildUrlContext().directOrigin;
    },
    get port() {
      return currentPort;
    },
    proxyPort: proxy.proxyPort,
    mode: proxy.mode,
    reason: proxy.reason,
    get urls() {
      return urlsFor(buildUrlContext());
    },
    identity: context,
    labels: {
      branch: claimed.parts.branch,
      project: claimed.parts.project ?? null,
      service: claimed.parts.service ?? null,
    },
    get env() {
      return childEnv(buildUrlContext(), config);
    },

    setPort: async (next) => {
      if (next === currentPort) {
        return;
      }
      const previous = currentPort;
      currentPort = next;
      config.hooks?.onPortChanged?.(previous, next);
      if (proxy.mode !== 'direct') {
        await register();
      }
    },

    printBanner: () => {
      const urlContext = buildUrlContext();
      const urls = urlsFor(urlContext);
      if (config.hooks?.onUrls?.(urls, urlContext) === false) {
        return;
      }
      if (quiet) {
        return;
      }
      print(
        renderBanner({
          project: identity.project,
          branch: identity.branch,
          service: identity.service,
          urls,
          directOrigin: urlContext.directOrigin,
          note: noteFor(proxy.mode, proxy.reason),
        }),
      );
    },

    release,
  };

  await config.hooks?.onResolved?.(buildUrlContext());
  return domain;
}

function activated(config: StaghornConfig, context: RepoContext): boolean {
  switch (config.activate ?? 'always') {
    case 'never':
      return false;
    case 'git':
      return context.isGit;
    case 'linkedWorktree':
      return context.isLinkedWorktree;
    default:
      return true;
  }
}

function plannedRouteKey(
  config: StaghornConfig,
  context: RepoContext,
  service: string | undefined,
): string {
  const tld = config.tld ?? DEFAULT_TLD;
  const identity = resolveIdentity(context, identityOverrides(config, tld, service));
  return buildRouteKey({
    branch: identity.branch,
    project: identity.project,
    service: identity.service,
  });
}

function identityOverrides(
  config: StaghornConfig,
  tld: string,
  service: string | undefined,
): Parameters<typeof resolveIdentity>[1] {
  const serviceConfig = service ? config.services?.[service] : undefined;
  // `subdomain: null` explicitly means "no service label", so it must not be
  // conflated with "not configured".
  const subdomain =
    serviceConfig && 'subdomain' in serviceConfig
      ? serviceConfig.subdomain
      : (service ?? null);
  return {
    tld,
    service: subdomain ?? null,
    ...(config.identity?.project === undefined
      ? {}
      : { project: config.identity.project }),
    ...(config.identity?.branch ? { branch: config.identity.branch } : {}),
    ...(config.identity?.slug?.transform
      ? { slugTransform: config.identity.slug.transform }
      : {}),
    ...(config.url?.primary ? { prefix: config.url.primary } : {}),
  };
}

async function resolvePort(
  config: StaghornConfig,
  routeKey: string,
  snapshot: RouteSnapshot,
  checkoutPath: string,
): Promise<number> {
  const ports = config.ports ?? {};
  if (ports.strategy === 'fixed' && ports.fixed) {
    return ports.fixed;
  }
  const [min = PORT_MIN, max = PORT_MAX] = ports.range ?? [];
  // A re-serve of this checkout reclaims its previous port (still probed - a
  // foreign server may have taken it meanwhile), so restarts keep a stable port
  // under either order. The ownership guard matters when `disambiguate: false`
  // lets a foreign checkout hold this key.
  const own = snapshot.get(routeKey);
  const previous =
    own && own.checkoutPath === checkoutPath && own.port >= min && own.port <= max
      ? own.port
      : undefined;
  const first = previous ?? (ports.order === 'sequential' ? min : undefined);
  // Ports other routes registered count as taken even before their server binds
  // (registered but still booting), so the walk skips them up front instead of
  // racing them at the probe.
  const claimed = new Set(
    [...snapshot.routes.entries()]
      .filter(([key]) => key !== routeKey)
      .map(([, route]) => route.port),
  );
  const picked = await pickPort(routeKey, {
    min,
    max,
    claimed,
    ...(first === undefined ? {} : { preferred: first }),
    ...(ports.probeHosts ? { hosts: ports.probeHosts } : {}),
  });
  // An exhausted range is not an error: the caller can let its dev server choose
  // and correct the registry afterwards via setPort.
  return picked ?? min + (snapshot.size % (max - min + 1));
}

type UrlQuery = NonNullable<NonNullable<StaghornConfig['url']>['query']>;

function renderQuery(query: UrlQuery | undefined): string {
  if (!query) {
    return '';
  }
  const pairs = Object.entries(query).flatMap(([key, value]) => {
    // Function values resolve at print time, so a token comes from the
    // environment and never from a config file committed to a repo.
    const resolved = typeof value === 'function' ? value() : value;
    return resolved === null || resolved === undefined
      ? []
      : [`${encodeURIComponent(key)}=${encodeURIComponent(resolved)}`];
  });
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

function childEnv(
  urlContext: UrlContext,
  config: StaghornConfig,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = {
    STAGHORN_HOST: urlContext.primaryHost,
    STAGHORN_ORIGIN: urlContext.origin,
    STAGHORN_ROUTE: urlContext.routeKey,
    STAGHORN_PORT: String(urlContext.port),
    STAGHORN_MODE: urlContext.mode,
  };
  const extra = config.rewrite?.env;
  const resolved = typeof extra === 'function' ? extra(urlContext) : extra;
  return { ...base, ...resolved };
}

function noteFor(mode: ProxyMode, reason: FallbackReason): string | null {
  if (mode === 'wildcard') {
    return null;
  }
  if (mode === 'sharedPort') {
    return 'the shared port is in use because :80 was unavailable; the hostname is unchanged';
  }
  if (reason === 'no-daemon-entry') {
    return 'running without the proxy: the daemon file could not be located';
  }
  if (reason === 'port-in-use-foreign') {
    return 'running without the proxy: another program owns the ports it would use';
  }
  return reason === 'disabled' ? null : 'running without the proxy';
}
