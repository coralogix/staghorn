// SPDX-License-Identifier: Apache-2.0
//
// The configuration surface.
//
// Two rules shaped this. First, the common case needs NO configuration at all -
// `npx staghorn -- npm run dev` has to work in a repo that has never heard of
// this package. Second, every assumption the tool makes has to have an escape
// hatch, because the assumptions that are invisible in one repo are load-bearing in
// the next.

import type { RepoContext } from '../identity/context';
import type { LogLevel, LogRecord } from '../log';
import type { ProxyMode } from '../ensure-proxy';

export interface StaghornConfig {
  /** Master switch. `STAGHORN_DISABLE=1` forces false. */
  readonly enabled?: boolean;

  /**
   * When the tool activates.
   *
   * Defaults to 'always', not 'linkedWorktree'. The predecessor only ever served
   * linked worktrees because that was its one use case, but a consumer with a
   * single clone still wants a named URL - and refusing them is refusing most of
   * the audience.
   */
  readonly activate?: 'always' | 'linkedWorktree' | 'git' | 'never';

  /**
   * DNS suffix every dev domain lives under.
   *
   *   'localhost'     RFC 6761 loopback, and a secure context. Chrome/Firefox/Edge.
   *                   NOT Safari, which does not implement the wildcard rule.
   *   'localtest.me'  public wildcard DNS pointing at 127.0.0.1. Every browser,
   *                   zero setup - but needs internet and is NOT a secure context.
   *   anything else    requires `devd hosts sync` or your own resolver.
   *
   * '*.dev' is rejected: it is HSTS-preloaded, so plain HTTP can never work there.
   */
  readonly tld?: string;

  readonly identity?: IdentityConfig;
  readonly url?: UrlShape;
  /** Several dev servers in one checkout: app + storybook + api. */
  readonly services?: Readonly<Record<string, ServiceConfig>>;
  readonly ports?: PortConfig;
  readonly proxy?: ProxyConfig;
  readonly daemon?: DaemonConfig;
  readonly state?: StateConfig;
  readonly rewrite?: RewriteConfig;
  readonly hooks?: Hooks;
  readonly log?: LogConfig;

  /**
   * Fixed hostnames claimed by whichever checkout holds them.
   *
   * The only honest answer to an OAuth redirect URI, which is registered against
   * one origin forever. `aliases: ['dev']` plus `devd claim dev` means the IdP
   * keeps pointing at `http://dev.<tld>/callback` and the claim decides which
   * checkout currently answers it.
   */
  readonly aliases?: readonly string[];

  /**
   * Final override layer, honoured only in the USER config.
   *
   * This exists for the developer whose machine disagrees with their team's
   * project config - a Safari user on a team that assumes Chrome, someone whose
   * :80 is owned by corporate software. Machine reality has to be able to win, or
   * they simply cannot use the tool.
   */
  readonly overrides?: Omit<StaghornConfig, 'overrides'>;

  /** Turn every degrade into a throw. For CI, never for a dev machine. */
  readonly strict?: boolean;
}

// ---------------------------------------------------------------- identity

export interface IdentityConfig {
  /** Explicit project label, or false to flatten it out of the host. */
  readonly project?: string | false;
  readonly branch?: string;
  readonly slug?: {
    readonly maxLength?: number;
    /** Runs after the default flattening; must return a legal DNS label. */
    readonly transform?: (raw: string, context: RepoContext) => string;
  };
  /** Collision suffixing. Rare once the project label is present. */
  readonly disambiguate?: boolean;
  /** Arbitrary labels attached to the route, surfaced by `devd list --json`. */
  readonly meta?: (context: RepoContext) => Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------- url shape

export interface UrlShape {
  /**
   * Subdomain prefix for the URL that gets PRINTED and handed to the app as its
   * canonical origin. null means a bare route host.
   */
  readonly primary?: string | null;
  /** Accept any prefix above the route key. On by default. */
  readonly wildcardPrefix?: boolean;
  /** Path the printed URL lands on. */
  readonly entryPath?: string;
  /**
   * Query parameters appended to the printed URL. Function values resolve at print
   * time, so a token comes from the environment and never from a config file
   * committed to a repo.
   */
  readonly query?: Readonly<
    Record<string, string | null | (() => string | null)>
  >;
  /** Full control: return one or many labelled URLs. */
  readonly buildUrls?: (context: UrlContext) => readonly LabelledUrl[];
}

export interface LabelledUrl {
  readonly label: string;
  readonly url: string;
}

export interface UrlContext {
  readonly routeKey: string;
  /** The registered host, without any prefix. */
  readonly host: string;
  /** The host including `url.primary`, which is what gets printed. */
  readonly primaryHost: string;
  readonly origin: string;
  readonly scheme: 'http' | 'https';
  /** Port the proxy listens on; null when portless. */
  readonly proxyPort: number | null;
  /** The dev server's own port. */
  readonly port: number;
  readonly directOrigin: string;
  readonly mode: ProxyMode;
  readonly service: string | null;
  readonly identity: RepoContext;
}

// ---------------------------------------------------------------- services

export interface ServiceConfig {
  /** Prefix inserted left of the branch. Defaults to the service key. */
  readonly subdomain?: string | null;
  readonly ports?: PortConfig;
  readonly url?: UrlShape;
  readonly rewrite?: RewriteConfig;
}

// ---------------------------------------------------------------- ports

export type PortStrategy = 'discover' | 'allocate' | 'fixed';

export interface PortConfig {
  /**
   * 'discover' (default in the CLI) let the dev server choose; learn the real port.
   * 'allocate' (default programmatically) we choose; the caller binds it.
   * 'fixed'    always `fixed`; simplest, and only safe one checkout at a time.
   *
   * Discovery is the default because it is what removes configuration from the
   * common case: no `--port {{port}}` in the consumer's command, and a dev server
   * that drifts to another port is observed rather than silently desynced.
   */
  readonly strategy?: PortStrategy;
  readonly fixed?: number;
  readonly range?: readonly [number, number];
  /**
   * First candidate when allocating. 'hash' (default): a stable hash of the
   * route key, so each checkout tends to keep its own port with zero state.
   * 'sequential': the bottom of the range, so the first serve on a machine gets
   * exactly `range[0]` - for ecosystems where something external pins that port
   * (an SSO bookmark, a proxy allowlist) and must keep matching the first
   * server. Either way a port this checkout already holds in the registry is
   * reclaimed first, so restarts keep their port.
   */
  readonly order?: 'hash' | 'sequential';
  readonly discovery?: {
    /** Scrape the child's output for its port. false disables. */
    readonly fromStdout?: RegExp | false;
    readonly timeoutMs?: number;
  };
  /** Loopback families a port must be free on. */
  readonly probeHosts?: readonly string[];
}

// ---------------------------------------------------------------- proxy

export interface ProxyConfig {
  /** 'auto' walks the ladder. A named mode pins one rung. */
  readonly mode?: 'auto' | ProxyMode;
  readonly wildcardPort?: number;
  readonly sharedPort?: number;
  /**
   * Which clients may be served.
   *
   * 'loopback' is the default and the reason the wildcard bind is safe. 'any' is
   * needed for a devcontainer whose host browser reaches in from 172.x, and it
   * undoes that guarantee - so it is explicit, and announced on every start.
   */
  readonly trustedClients?: 'loopback' | 'any' | readonly string[];
  readonly upstreamHosts?: readonly string[];
  /** Add x-forwarded-*; Rails/Django/Laravel need it to build absolute URLs. */
  readonly forwardedHeaders?: boolean;
  /** Command shown on error pages. Resolved from the consumer's setup. */
  readonly listCommand?: string;
}

// ---------------------------------------------------------------- daemon

export interface DaemonConfig {
  /**
   * 'shared'    one machine-wide daemon (default).
   * 'inProcess' the daemon runs inside this process - Windows, one checkout, CI.
   * 'external'  never spawn; something else runs it (docker compose).
   */
  readonly mode?: 'shared' | 'inProcess' | 'external';
  readonly lifetime?: {
    readonly policy?: 'lease' | 'forever';
    readonly lingerMs?: number;
    readonly bootGraceMs?: number;
    readonly maxLeases?: number;
  };
  /** Explicit path to the daemon file, bypassing resolution. */
  readonly entry?: string;
}

// ---------------------------------------------------------------- state

export interface StateConfig {
  readonly dir?: string;
  /** Liveness check, so container and remote topologies can redefine it. */
  readonly isAlive?: (pid: number) => boolean;
}

// ---------------------------------------------------------------- rewrite

export interface RewriteConfig {
  /** Extra environment for the wrapped child, on top of the STAGHORN_* family. */
  readonly env?:
    | Readonly<Record<string, string>>
    | ((context: UrlContext) => Readonly<Record<string, string>>);
  /** Applied by transformHtml and by the Vite adapter. */
  readonly replacements?: readonly {
    readonly find: string | RegExp;
    readonly replace: string | ((match: string, context: UrlContext) => string);
  }[];
  readonly transformHtml?: (
    html: string,
    context: UrlContext,
  ) => string | Promise<string>;
}

// ---------------------------------------------------------------- hooks

export interface Hooks {
  readonly onResolved?: (context: UrlContext) => void | Promise<void>;
  readonly onPortChanged?: (from: number | null, to: number) => void;
  /** Return false to suppress the default banner entirely. */
  readonly onUrls?: (
    urls: readonly LabelledUrl[],
    context: UrlContext,
  ) => void | false;
  readonly onFallback?: (info: {
    readonly from: ProxyMode;
    readonly to: ProxyMode;
    readonly reason: string;
  }) => void;
  readonly onError?: (error: Error, phase: string) => void;
}

export interface LogConfig {
  readonly level?: LogLevel;
  readonly sink?: (record: LogRecord) => void;
  /** OSC-8 hyperlinks and colour. 'auto' detects a TTY. */
  readonly links?: boolean | 'auto';
}
