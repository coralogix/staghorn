// The CLI, as a function.
//
// `run(io)` takes its argv, env, cwd and streams as arguments and returns an exit
// code. `bin.ts` is the only place that touches the real process. That is what makes
// every CLI surface below assertable as a string, which the predecessor's three
// scripts were not - they read process.argv and called process.exit directly, so
// none of them had a single test.

import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

import { renderBanner, terminalLink } from '../banner';
import { loadConfig } from '../config/load';
import { probeProxy, requestShutdown } from '../control-client';
import { createDevDomain, type DevDomain } from '../create-dev-domain';
import { errorMessage } from '../errors';
import { proxyLogPath, stateDir } from '../paths';
import {
  DEFAULT_SHARED_PORT,
  DEFAULT_WILDCARD_PORT,
  PROTOCOL_VERSION,
  isProtocolCompatible,
} from '../protocol';
import { createDaemonInfoStore, isForeignUid } from '../state/daemon-info';
import { createFileRouteStore, type DevRoute } from '../state/routes';
import { VERSION } from '../version';
import { createPortScanner } from './discover-port';

export interface Io {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly isTty?: boolean;
}

const USAGE = `staghorn ${VERSION} - every branch gets its own localhost hostname

  staghorn -- <command>        run a dev server behind its own hostname
  staghorn list [--json]       show the dev servers that are live
  staghorn url [--json]        print this checkout's hostname
  staghorn status [--json]     show the shared daemon
  staghorn stop                stop the shared daemon
  staghorn prune               drop routes whose process is gone
  staghorn doctor              diagnose this machine
  staghorn config --print      show the resolved config and where each value came from

  --service <name>             which dev server in this checkout (app, storybook, ...)
  --allocate                   choose the port instead of discovering it
  --quiet                      no banner
  --help, --version
`;

export async function run(io: Io): Promise<number> {
  const args = [...io.argv];
  // Everything after `--` is the wrapped command, never parsed as our own flags.
  const separator = args.indexOf('--');
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const own = separator === -1 ? args : args.slice(0, separator);
  const flags = parseFlags(own);

  if (flags.boolean.has('help') || flags.boolean.has('h')) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (flags.boolean.has('version') || flags.boolean.has('V')) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [subcommand] = flags.positional;
  try {
    switch (subcommand) {
      case undefined:
        return command.length > 0
          ? await wrap(io, command, flags)
          : usageError(io, 'nothing to run. Try: staghorn -- npm run dev');
      case 'list':
      case 'ls':
        return await list(io, flags);
      case 'url':
        return await url(io, flags);
      case 'status':
        return await status(io, flags);
      case 'stop':
        return await stop(io);
      case 'prune':
        return await prune(io);
      case 'doctor':
        return await doctor(io);
      case 'config':
        return await printConfig(io, flags);
      default:
        return usageError(io, `unknown command: ${subcommand}`);
    }
  } catch (err) {
    io.stderr.write(`staghorn: ${errorMessage(err)}\n`);
    return 1;
  }
}

// --- the wrapper: the primary path ---------------------------------------

async function wrap(io: Io, command: string[], flags: Flags): Promise<number> {
  const service = flags.value.get('service');
  const allocate = flags.boolean.has('allocate');
  const domain = await createDevDomain({
    cwd: io.cwd,
    quiet: true,
    ...(service ? { service } : {}),
    ports: { strategy: allocate ? 'allocate' : 'discover' },
  });

  const [bin, ...rest] = command;
  if (bin === undefined) {
    return usageError(io, 'nothing to run after --');
  }

  // Discovery watches the child's own output. The proxy's port is excluded so our
  // banner cannot be scraped back in as if it were the dev server's.
  const scanner = createPortScanner({
    ignore: [domain.proxyPort ?? DEFAULT_SHARED_PORT, DEFAULT_WILDCARD_PORT],
  });

  const child = spawn(bin, rest, {
    cwd: io.cwd,
    env: { ...io.env, ...domain.env, ...(allocate ? { PORT: String(domain.port) } : {}) },
    // stdout is piped so it can be scanned, then written through unchanged; stdin is
    // inherited so an interactive dev server still works.
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let banneredAt: number | null = null;
  const onChunk = (chunk: Buffer, out: Writable): void => {
    out.write(chunk);
    const port = scanner.push(chunk.toString('utf8'));
    if (port !== null && port !== banneredAt) {
      banneredAt = port;
      void domain.setPort(port).then(() => printBanner(io, domain));
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => onChunk(chunk, io.stdout));
  child.stderr?.on('data', (chunk: Buffer) => onChunk(chunk, io.stderr));

  if (allocate) {
    printBanner(io, domain);
  }

  // Forward signals rather than dying first: the child owns the terminal, and it
  // deserves the chance to shut down cleanly.
  const forward = (signal: NodeJS.Signals) => () => {
    child.kill(signal);
  };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      io.stderr.write(`staghorn: could not run ${bin}: ${errorMessage(err)}\n`);
      resolve(127);
    });
    child.on('exit', (exitCode, signal) => {
      resolve(signal ? 128 + signalNumber(signal) : (exitCode ?? 0));
    });
  });

  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  await domain.release();

  if (scanner.found === null && !allocate) {
    io.stderr.write(
      `\nstaghorn: no dev-server port appeared in the output, so nothing was routed.\n` +
        `  Use --allocate to have staghorn pick the port, or set ports.fixed in your config.\n`,
    );
  }
  return code;
}

function printBanner(io: Io, domain: DevDomain): void {
  io.stderr.write(`\n${renderBannerFor(io, domain)}\n\n`);
}

function renderBannerFor(io: Io, domain: DevDomain): string {
  return renderBanner({
    // The resolved labels, not `identity.packageName` (the raw package name, which
    // ignores a configured project label) and not `routeKey` (all three joined).
    project: domain.labels.project,
    branch: domain.labels.branch,
    service: domain.labels.service,
    urls: domain.urls,
    directOrigin: domain.directOrigin,
    isTty: io.isTty ?? false,
  });
}

// --- read-only commands --------------------------------------------------

async function list(io: Io, flags: Flags): Promise<number> {
  const store = createFileRouteStore();
  await store.prune();
  const snapshot = await store.read();
  const routes = [...snapshot.routes.values()].sort((a, b) =>
    a.routeKey.localeCompare(b.routeKey),
  );
  const daemon = await createDaemonInfoStore().read();
  const tld = (await loadConfig({ cwd: io.cwd })).config.tld ?? 'localhost';

  if (flags.boolean.has('json')) {
    io.stdout.write(`${JSON.stringify({ routes, daemon }, null, 2)}\n`);
    return 0;
  }
  if (routes.length === 0) {
    io.stdout.write('No dev servers are running.\n');
    return 0;
  }
  const rows = routes.map((route) => ({
    host: `${route.routeKey}.${tld}`,
    port: String(route.port),
    branch: route.branch ?? '-',
    url: hostUrl(route, tld, daemon?.port ?? null),
  }));
  const widths = {
    host: max(rows.map((r) => r.host.length), 'HOST'.length),
    port: max(rows.map((r) => r.port.length), 'PORT'.length),
    branch: max(rows.map((r) => r.branch.length), 'BRANCH'.length),
  };
  io.stdout.write(
    `${'HOST'.padEnd(widths.host)}  ${'PORT'.padEnd(widths.port)}  ${'BRANCH'.padEnd(widths.branch)}  URL\n`,
  );
  for (const row of rows) {
    io.stdout.write(
      `${row.host.padEnd(widths.host)}  ${row.port.padEnd(widths.port)}  ${row.branch.padEnd(widths.branch)}  ${terminalLink(row.url, io.isTty ?? false)}\n`,
    );
  }
  return 0;
}

async function url(io: Io, flags: Flags): Promise<number> {
  const service = flags.value.get('service');
  const domain = await createDevDomain({
    cwd: io.cwd,
    quiet: true,
    ...(service ? { service } : {}),
  });
  try {
    if (flags.boolean.has('json')) {
      io.stdout.write(
        `${JSON.stringify(
          {
            routeKey: domain.routeKey,
            host: domain.host,
            origin: domain.origin,
            directOrigin: domain.directOrigin,
            mode: domain.mode,
            urls: domain.urls,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    for (const { url: value } of domain.urls) {
      io.stdout.write(`${value}\n`);
    }
    return 0;
  } finally {
    // `url` is a query, not a claim: it must not leave a route behind.
    await domain.release();
  }
}

async function status(io: Io, flags: Flags): Promise<number> {
  const outcome = await probeCandidates();
  if (flags.boolean.has('json')) {
    io.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }
  if (!outcome.status) {
    io.stdout.write('No staghorn daemon is running.\n');
    return 0;
  }
  const { status: found } = outcome;
  io.stdout.write(
    [
      `daemon    pid ${found.pid} on :${found.port}`,
      `version   ${found.version} (protocol v${found.protocol})`,
      `routes    ${found.routes}`,
      `leases    ${found.leases}`,
      `state     ${found.stateDir}`,
      ...(isProtocolCompatible(found.protocol)
        ? []
        : [
            `warning   this daemon speaks protocol v${found.protocol}, this CLI speaks v${PROTOCOL_VERSION}`,
          ]),
      ...(isForeignUid(found.uid) ? ['warning   owned by another user'] : []),
    ].join('\n') + '\n',
  );
  return 0;
}

async function stop(io: Io): Promise<number> {
  const outcome = await probeCandidates();
  if (!outcome.status) {
    io.stdout.write('No staghorn daemon is running.\n');
    return 0;
  }
  // Never stop someone else's daemon - but only when it POSITIVELY is someone
  // else's. `!isCurrentUid` would refuse to stop our own daemon on any platform
  // without uids, which is the one thing `stop` exists to do.
  if (isForeignUid(outcome.status.uid)) {
    io.stderr.write(
      `staghorn: the daemon on :${outcome.status.port} belongs to another user; refusing to stop it.\n`,
    );
    return 1;
  }
  const stopped = await requestShutdown(outcome.status.port);
  io.stdout.write(
    stopped
      ? `Stopped the daemon on :${outcome.status.port}.\n`
      : `Could not stop the daemon on :${outcome.status.port}.\n`,
  );
  return stopped ? 0 : 1;
}

async function prune(io: Io): Promise<number> {
  const { removed, kept } = await createFileRouteStore().prune();
  io.stdout.write(
    removed.length === 0
      ? `Nothing to prune (${kept} live).\n`
      : `Removed ${removed.length} dead route(s): ${removed.join(', ')} (${kept} live).\n`,
  );
  return 0;
}

async function doctor(io: Io): Promise<number> {
  const lines: string[] = [`staghorn ${VERSION}`, ''];
  lines.push(`platform    ${process.platform} (node ${process.versions.node})`);
  lines.push(`state dir   ${stateDir()}`);
  lines.push(`daemon log  ${proxyLogPath()}`);

  const wildcard = await probeProxy(DEFAULT_WILDCARD_PORT);
  const shared = await probeProxy(DEFAULT_SHARED_PORT);
  lines.push(`:${DEFAULT_WILDCARD_PORT}         ${describeProbe(wildcard.kind)}`);
  lines.push(`:${DEFAULT_SHARED_PORT}       ${describeProbe(shared.kind)}`);

  if (process.platform === 'linux' && wildcard.kind === 'absent') {
    lines.push(
      '',
      'note        stock Linux forbids an unprivileged bind below 1024, so the',
      `            shared port (:${DEFAULT_SHARED_PORT}) is the expected rung. To get portless URLs:`,
      '              sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80',
    );
  }
  // Not fixable in code, but very much diagnosable - and it is a common cause of
  // "the hostname does not resolve" reports.
  const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].filter(
    (key) => io.env[key] ?? io.env[key.toLowerCase()],
  );
  if (proxyEnv.length > 0) {
    lines.push(
      '',
      `note        a proxy is configured (${proxyEnv.join(', ')}). Add *.localhost`,
      '            to NO_PROXY so dev hostnames bypass it.',
    );
  }
  if (process.platform === 'darwin') {
    lines.push(
      '',
      'note        Safari does not resolve *.localhost. Use another browser, or set',
      "            tld: 'localtest.me' in your config.",
    );
  }
  io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function printConfig(io: Io, flags: Flags): Promise<number> {
  const { config, provenance, files } = await loadConfig({ cwd: io.cwd, env: io.env });
  if (flags.boolean.has('json')) {
    io.stdout.write(
      `${JSON.stringify(
        { config, files, provenance: Object.fromEntries(provenance) },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const entries = [...provenance.entries()].sort(([a], [b]) => a.localeCompare(b));
  const width = max(
    entries.map(([key]) => key.length),
    3,
  );
  for (const [key, source] of entries) {
    const where = source.file ? `${source.layer} (${source.file})` : source.layer;
    io.stdout.write(`${key.padEnd(width)}  ${where}\n`);
  }
  if (files.length > 0) {
    io.stdout.write(`\nfiles read:\n${files.map((f) => `  ${f}`).join('\n')}\n`);
  }
  return 0;
}

// --- helpers -------------------------------------------------------------

async function probeCandidates(): Promise<{
  status: import('../protocol').ProxyStatus | null;
  probed: number[];
}> {
  // The advertised address first, so a daemon on a non-default port is found
  // without guessing.
  const advertised = await createDaemonInfoStore().read();
  const candidates = [
    ...(advertised ? [advertised.port] : []),
    DEFAULT_WILDCARD_PORT,
    DEFAULT_SHARED_PORT,
  ].filter((port, index, all) => all.indexOf(port) === index);
  for (const port of candidates) {
    const outcome = await probeProxy(port);
    if (outcome.kind === 'ours' || outcome.kind === 'legacy') {
      return { status: outcome.status, probed: candidates };
    }
  }
  return { status: null, probed: candidates };
}

function describeProbe(kind: string): string {
  switch (kind) {
    case 'ours':
      return 'staghorn daemon';
    case 'legacy':
      return 'an older staghorn daemon (restart it to pick up new behaviour)';
    case 'foreign':
      return 'something else is listening';
    default:
      return 'free';
  }
}

function hostUrl(route: DevRoute, tld: string, daemonPort: number | null): string {
  const portless = daemonPort === null || daemonPort === DEFAULT_WILDCARD_PORT;
  const suffix = portless ? '' : `:${daemonPort}`;
  return `http://${route.routeKey}.${tld}${suffix}`;
}

interface Flags {
  readonly boolean: ReadonlySet<string>;
  readonly value: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
}

function parseFlags(args: readonly string[]): Flags {
  const boolean = new Set<string>();
  const value = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.replace(/^-+/, '');
    const [key, inline] = name.split('=', 2);
    if (key === undefined) {
      continue;
    }
    if (inline !== undefined) {
      value.set(key, inline);
      continue;
    }
    const next = args[i + 1];
    // Only flags that take a value consume the next token, so `--json list` does
    // not silently swallow the subcommand.
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
      value.set(key, next);
      i++;
      continue;
    }
    boolean.add(key);
  }
  return { boolean, value, positional };
}

const VALUE_FLAGS = new Set(['service', 'tld', 'project', 'port']);

function usageError(io: Io, message: string): number {
  io.stderr.write(`staghorn: ${message}\n\n${USAGE}`);
  return 2;
}

function max(values: readonly number[], floor: number): number {
  return values.reduce((best, value) => Math.max(best, value), floor);
}

function signalNumber(signal: NodeJS.Signals): number {
  const known: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 };
  return known[signal] ?? 0;
}
