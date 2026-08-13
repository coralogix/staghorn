# staghorn

Every git branch gets its own localhost hostname instead of a port.

```
http://feature-x.myapp.localhost        not  http://localhost:5173
http://main.myapp.localhost             not  http://localhost:5174
http://storybook.feature-x.myapp.localhost
```

One shared daemon routes by `Host` header to the right dev server, and exits when the
last dev server does. No runtime dependencies, no sudo, no `/etc/hosts`, no DNS
server, no certificates.

Named after the branching coral, *Acropora cervicornis*: many branches, one skeleton.

## Quickstart

Wrap whatever you already run:

```bash
npx staghorn -- npm run dev
```

```
  ▸ project  myapp
  ▸ branch   feature-x
  ▸ url      http://feature-x.myapp.localhost
  ▸ direct   http://localhost:5173   (always works)

  VITE v6.0.0  ready in 412 ms
```

No config file, no code change, no `--port` plumbing. staghorn ran your command
unchanged, learned the real port from its output, registered the route and printed the
hostname.

## Why a hostname beats a port

- **Stable.** The URL is a function of your branch and project, not of what order you
  started things in. It stays bookmarkable across restarts.
- **Parallel.** Several worktrees serve at once without colliding, and without anyone
  having to remember that 5174 is the review branch.
- **Honest cookies and origins.** `*.localhost` is a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
  so `Secure` cookies, service workers and origin-sensitive APIs behave as they do in
  production. Separate hostnames also mean separate cookie jars and separate
  `localStorage`, so two branches cannot corrupt each other's session.

## How it works

Four parts, in order of how much you need to care:

1. **Your dev server** binds whatever port it likes. staghorn does not care which.
2. **A route file** in `~/.staghorn/routes/` maps `feature-x.myapp` to that port. One
   file per route, so two dev servers starting at the same instant cannot lose each
   other's registration.
3. **One shared daemon** binds a single port and forwards each request to the dev
   server named by its `Host` header. WebSockets and SSE pass through untouched, so
   HMR works.
4. **A lease** keeps the daemon alive. Every dev server holds an open connection for
   its lifetime; the OS closes it however the process ends, including `SIGKILL`. When
   the last one closes, the daemon exits. It never outlives the work it was started
   for.

### Why no sudo

macOS (Mojave and later) allows an unprivileged process to bind a port below 1024
**only on the wildcard address** - binding `127.0.0.1:80` is still root-only. So the
daemon binds the wildcard and enforces loopback-only clients itself, at three layers:
at accept time, per request, and per upgrade.

### Why no DNS setup

Browsers resolve `*.localhost` to loopback themselves, per
[RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.3). Chrome, Firefox and
Edge implement this. **Safari does not** - see [Safari](#safari).

## The fallback ladder

staghorn never fails in a way that stops your dev server. If a rung is unavailable it
takes the next one and prints one line saying so. **The hostname is identical on every
rung** - only the port appears - so a bookmark survives a degrade.

| Rung | You get | When |
| --- | --- | --- |
| wildcard `:80` | `http://feature-x.myapp.localhost` | macOS, most Windows, Linux with a sysctl |
| shared `:4180` | `http://feature-x.myapp.localhost:4180` | Linux by default; anything already owns `:80` |
| direct | `http://localhost:5173` | no daemon could start at all |

Linux is fully supported and lands on the shared port by default. You lose the
cosmetic portlessness and keep everything that matters: a stable name that never
drifts, and one constant port for every checkout. To get rung 1 on Linux:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
```

## Commands

```
staghorn -- <command>        run a dev server behind its own hostname
staghorn list                show the dev servers that are live
staghorn url                 print this checkout's hostname
staghorn status              show the shared daemon
staghorn stop                stop the shared daemon
staghorn prune               drop routes whose process is gone
staghorn doctor              diagnose this machine
staghorn config --print      show the resolved config, and where each value came from
```

`staghorn` and `stag` are the same command. `--json` works on `list`, `url`, `status`
and `config`.

## The hostname

```
[<prefix>.]{<service>.}<branch>.<project>.<tld>
     ^          ^           ^        ^
 anything    optional    slugged   grouping label
 your app    per-server   branch
 wants
```

The **project** label is on by default and is not cosmetic. Every project has a
`main`; without it, two checkouts collide and get order-dependent `-2` suffixes that
flip between boots, which makes URLs unbookmarkable and ports unstable. Set
`identity.project: false` to flatten it away.

Routing is a **longest registered suffix match**, so a service route beats the app
route beneath it and any prefix your app wants above it is ignored:

```
team-a.storybook.feature-x.myapp.localhost  ->  storybook.feature-x.myapp
team-a.feature-x.myapp.localhost            ->  feature-x.myapp
```

## Configuration

None is required. When you want it, `staghorn.config.ts` (or `.mjs`, `.json`, or a
`staghorn` key in `package.json`):

```ts
import { defineConfig } from 'staghorn/config';

export default defineConfig({
  // Subdomain the printed URL uses, if your app wants one.
  url: { primary: 'dashboard', entryPath: '/login' },

  // Several dev servers in one checkout.
  services: {
    app: {},
    storybook: { subdomain: 'storybook' },
  },

  // Safari, or any resolver that does not do *.localhost.
  tld: 'localtest.me',
});
```

Layers, low to high: defaults, user config, project config, `STAGHORN_*` environment,
CLI flags, programmatic options, and finally the `overrides` block of the *user*
config - so a developer's machine can always beat their team's project config.
`staghorn config --print` shows where every value came from.

Environment variables mirror the config keys: `STAGHORN_DISABLE`, `STAGHORN_TLD`,
`STAGHORN_MODE`, `STAGHORN_PORT`, `STAGHORN_PROJECT`, `STAGHORN_STATE_DIR`,
`STAGHORN_LOG`.

## Programmatic use

For a repo that already owns its dev script:

```ts
import { createDevDomain } from 'staghorn';

const domain = await createDevDomain({ ports: { strategy: 'allocate' } });
await startMyServer(domain.port, { origin: domain.origin });
domain.printBanner();

// If your server ended up on a different port than requested:
await domain.setPort(actualPort);
```

`resolveDevDomain()` answers what *would* happen with no side effects at all - no
registry write, no spawn, no lease - for a script that wants to decide first.

## Platform support

| | |
| --- | --- |
| **macOS** | Fully supported. Portless by default. |
| **Linux** | Fully supported. Shared port by default; portless with the sysctl above. |
| **Windows** | Supported, less exercised. Ports below 1024 are not restricted, so portless often works; `http.sys`/IIS may own `:80`, in which case the shared port is used. |
| **Containers, WSL2** | Works with explicit configuration. Run `staghorn doctor`. |

Node 20.11 or newer. Installs cleanly under npm, pnpm, yarn (including PnP) and bun.

## Known limitations

### Safari

Safari does not implement the `*.localhost` rule, so hostnames will not resolve.
Either use another browser, or set `tld: 'localtest.me'` - a public wildcard DNS name
that points at `127.0.0.1`, needs no setup, and works everywhere. Note it requires
internet access and is not a secure context.

### HTTPS

Dev stays plain HTTP, which is fine because `*.localhost` is already a secure context.
If your app genuinely needs TLS (WebAuthn, or an identity provider that refuses
`http://` redirect URIs), supply your own certificate from
[mkcert](https://github.com/FiloSottile/mkcert). staghorn will never generate
certificates or install a certificate authority into your trust store.

### Fixed-origin OAuth redirects

An identity provider registers one redirect URI forever, which no per-branch hostname
can satisfy. Use an alias: `aliases: ['dev']` plus `staghorn claim dev` points
`http://dev.localhost/callback` at whichever checkout currently holds the claim.

### Corporate proxies

If `HTTP_PROXY` is set, add `*.localhost` to `NO_PROXY` or your browser will send dev
requests to the corporate proxy. `staghorn doctor` detects this and says so.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `npm test` needs nothing but a Node install;
no test binds a privileged port.

## License

[Apache-2.0](./LICENSE)
