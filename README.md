<p>
  Built with 💚 by
  <a href="https://coralogix.com/?utm_source=github&amp;utm_medium=oss&amp;utm_campaign=Staghorn">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/coralogix/staghorn/main/assets/coralogix-horizontal-white-inline.svg">
      <img src="https://raw.githubusercontent.com/coralogix/staghorn/main/assets/coralogix-horizontal-black-inline.svg" alt="Coralogix" height="24" align="middle">
    </picture>
  </a>
</p>

# Staghorn

📖 **Docs:** [Staghorn documentation](https://coralogix.github.io/staghorn/)

Two branches running at once, and you can never remember whether the review one is on
5173 or 5174. Logging into one clobbers your session in the other, because cookies
ignore the port: `localhost` is a single origin however many dev servers you put
behind it. Bookmarks rot as soon as something starts in a different order.

Staghorn gives every branch its own hostname instead.

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

Install it in your project:

```bash
npm install -D @coralogix/staghorn
```

(or `pnpm add -D`, `yarn add -D`, `bun add -d`), then put `staghorn --` in front of the
dev script you already have:

```json
{
  "scripts": {
    "dev": "staghorn -- vite"
  }
}
```

```bash
npm run dev
```

```
  ▸ project  myapp
  ▸ branch   feature-x
  ▸ url      http://feature-x.myapp.localhost
  ▸ direct   http://localhost:5173   (always works)

  VITE v6.0.0  ready in 412 ms
```

No config file, no code change, no `--port` plumbing. Staghorn ran your command
unchanged, learned the real port from its output, registered the route and printed the
hostname. `staghorn` and its alias `stag` are the same command.

To try it once without installing, use the full scoped name:

```bash
npx @coralogix/staghorn -- npm run dev
```

(or `pnpm dlx @coralogix/staghorn`, `yarn dlx @coralogix/staghorn`,
`bunx @coralogix/staghorn`).

> **Warning:** never shorten the package name when running it without installing.
> `npx staghorn`, `npx stag`, `pnpm dlx staghorn`, `bunx stag` and the like only
> resolve inside a project that already has `@coralogix/staghorn` installed. Anywhere
> else, always use the full scoped name.

## Rolling it out to a team

Staghorn is meant to be adopted once, for everyone. One pull request adds it to the
project:

```diff
  "devDependencies": {
+   "@coralogix/staghorn": "^0.1.2"
  },
  "scripts": {
-   "dev": "vite"
+   "dev": "staghorn -- vite"
  }
```

After that, every engineer's next `npm run dev` works: no `sudo`, no trust prompt, no
certificate, no hosts-file edit, and nothing to install globally. Their command runs
unchanged. If something about a machine gets in the way, staghorn falls back a rung and
says so; it never blocks the dev server.

Anyone who wants out sets `STAGHORN_DISABLE=1`. Anyone who needs a different setup
puts it under `overrides` in their own `~/.config/staghorn/staghorn.config.json`, which
beats the project's config, so the shared config never changes for one person:

```json
{ "overrides": { "tld": "localtest.me" } }
```

## Why a hostname beats a port

- **Stable.** The URL is a function of your branch and project, not of what order you
  started things in. It stays bookmarkable across restarts.
- **Parallel.** Several worktrees serve at once without colliding, and without anyone
  having to remember that 5174 is the review branch. That includes the worktrees a
  coding agent opens on your behalf, where the port arithmetic stops being tractable
  fastest because nobody chose the order they started in.
- **Honest cookies and origins.** `*.localhost` is a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
  so `Secure` cookies, service workers and origin-sensitive APIs behave as they do in
  production. Separate hostnames also mean separate cookie jars and separate
  `localStorage`, so two branches cannot corrupt each other's session.

## If your app reads the subdomain

An app that resolves a tenant, team or workspace from the host cannot be exercised on
`localhost:5173` at all, because there is no subdomain there to read. The usual
workarounds are a hand-maintained `/etc/hosts`, a dnsmasq config, or a local Caddy in
front of the dev server - per developer, per machine, and stale the moment someone
adds a tenant.

Any prefix above the route is accepted and forwarded to the same dev server, so this
works with nothing to install and nothing to keep up to date:

```
acme.feature-x.myapp.localhost      ->  feature-x.myapp
globex.feature-x.myapp.localhost    ->  feature-x.myapp
```

Your app reads `acme` or `globex` off the `Host` header exactly as it does in
production. Testing another tenant means typing another URL.

## How it works

Four parts, in order of how much you need to care:

1. **Your dev server** binds whatever port it likes. Staghorn does not care which.
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

Staghorn never fails in a way that stops your dev server. If a rung is unavailable it
takes the next one and prints one line saying so. **The hostname is identical on every
rung** - only the port appears - so a bookmark survives a degrade.

| Rung | You get | When |
| --- | --- | --- |
| wildcard `:80` | `http://feature-x.myapp.localhost` | macOS, most Windows, Linux with a sysctl |
| shared `:4180` | `http://feature-x.myapp.localhost:4180` | Linux by default; anything already owns `:80` |
| direct | `http://localhost:5173` | no daemon could start at all |

Linux is fully supported and lands on the shared port by default. You lose the
cosmetic port-free URL and keep everything that matters: a stable name that never
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

`staghorn` and `stag` are the same command once installed. `--json` works on `list`, `url`, `status`
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
`staghorn` key in `package.json`). A `.ts` config is imported directly, so it needs
Node 22.18+ or 23.6+; on older Node use `.mjs`:

```ts
import { defineConfig } from '@coralogix/staghorn/config';

export default defineConfig({
  // Subdomain and path the printed URL uses, if your app wants them. `primary`
  // becomes `www.<branch>.<project>.localhost`; `entryPath` is where the banner
  // link lands, so you can go straight to the page you actually work on.
  url: { primary: 'www', entryPath: '/signin' },

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

Environment variables mirror the config keys: `STAGHORN_DISABLE=1`, `STAGHORN_TLD`,
`STAGHORN_MODE`, `STAGHORN_PORT` (pins the dev server's port), `STAGHORN_PROJECT`,
`STAGHORN_STATE_DIR`, `STAGHORN_LOG`. The
[configuration guide](https://coralogix.github.io/staghorn/guide/configuration) lists
the accepted values, and the variables your dev server receives.

## Programmatic use

For a repo that already owns its dev script:

```ts
import { createDevDomain } from '@coralogix/staghorn';

const domain = await createDevDomain({ ports: { strategy: 'allocate' } });
await startMyServer(domain.port, { origin: domain.origin });
domain.printBanner();

// If your server ended up on a different port than requested:
await domain.setPort(actualPort);
```

Allocation picks a stable hash of the route key by default, so each checkout
tends to keep its own port. When something external pins a specific port - an
SSO bookmark, a proxy allowlist - allocate sequentially instead, so the first
serve on a machine gets exactly the bottom of the range:

```ts
const domain = await createDevDomain({
  ports: { strategy: 'allocate', order: 'sequential', range: [4200, 4999] },
});
```

Either way a checkout reclaims the port it already holds in the registry, so
restarts keep their port.

`resolveDevDomain()` answers what *would* happen with no side effects at all - no
registry write, no spawn, no lease - for a script that wants to decide first.

## Platform support

| | |
| --- | --- |
| **macOS** | Fully supported. No port in the URL by default. |
| **Linux** | Fully supported. Shared port by default; no port in the URL with the sysctl above. |
| **Windows** | Supported, less exercised. Ports below 1024 are not restricted, so the port-free URL often works; `http.sys`/IIS may own `:80`, in which case the shared port is used. |
| **Containers, WSL2** | Works with explicit configuration. Run `staghorn doctor`. |

Node 20.11 or newer. Installs cleanly under npm, pnpm, yarn (including PnP) and bun.

## Known limitations

### Safari

Safari does not implement the `*.localhost` rule, so hostnames will not resolve.
Either use another browser, or set `tld: 'localtest.me'` - a public wildcard DNS name
that points at `127.0.0.1`, needs no setup, and works everywhere. Note it requires
internet access and is not a secure context. Vite rejects hostnames it does not
recognise, so a Vite project also needs `server: { allowedHosts: ['.localtest.me'] }`.

### HTTPS

Dev stays plain HTTP, which is fine because `*.localhost` is already a secure context.
If your app genuinely needs TLS (WebAuthn, or an identity provider that refuses
`http://` redirect URIs), supply your own certificate from
[mkcert](https://github.com/FiloSottile/mkcert). Staghorn will never generate
certificates or install a certificate authority into your trust store.

### Fixed-origin OAuth redirects

An identity provider registers one redirect URI forever, which no per-branch hostname
can satisfy. Point the provider at the fixed origin your dev server also listens on
(`http://localhost:<port>/callback`, the `direct` rung), complete the flow there, then
continue on the branch hostname. Both are loopback origins, so a session cookie scoped
to the tld is visible to each. A claimable fixed alias is a likely future addition.

### Corporate proxies

If `HTTP_PROXY` is set, add `*.localhost` to `NO_PROXY` or your browser will send dev
requests to the corporate proxy. `staghorn doctor` detects this and says so.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `npm test` needs nothing but a Node install;
no test binds a privileged port.

## License

[Apache-2.0](./LICENSE)
