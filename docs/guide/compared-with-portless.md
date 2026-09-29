# Staghorn or portless?

[portless](https://github.com/vercel-labs/portless) solves the same problem: named
`.localhost` URLs instead of port numbers. The two make different trade-offs, and this
page lays them out so you can pick quickly.

The short version: **a team adopts staghorn in one pull request, and nobody runs
`sudo` or approves a trust prompt.** It never needs root and never changes anyone's
machine. portless does more, and some of that needs `sudo`, a local certificate
authority and edits to `/etc/hosts` on every engineer's machine.

::: info As of portless 0.15.6
Checked against portless's own README and source in September 2026. If something here
is out of date, please [open an issue](https://github.com/coralogix/staghorn/issues).
:::

## Pick staghorn if you need

- **One change for the whole team.** A platform team adds staghorn to the project and
  wraps the `dev` script, and every engineer's next `npm run dev` works: no `sudo`, no
  trust prompt, nothing installed globally, and no change to how anyone works. If
  something goes wrong it falls back and warns rather than blocking a dev server, and
  anyone can opt out with `STAGHORN_DISABLE=1`. portless's first run generates and
  trusts a certificate authority and elevates with `sudo` on each machine; until an
  engineer has done that interactively, non-interactive runs such as Turborepo exit
  with an error instead of prompting.
- **Nothing privileged, nothing installed.** No certificate authority in your trust
  store, no `/etc/hosts` entries, no background service, so it works on a managed
  laptop where those are locked down. Staghorn binds the wildcard address, which macOS
  lets an unprivileged process do even below port 1024, and enforces loopback-only
  clients itself. portless serves HTTPS on port 443 by default and elevates with `sudo`
  to bind it; its unprivileged option is a high port such as `:1355` in the URL. On
  Linux, staghorn's URL carries `:4180`; an optional one-time `sysctl` removes it - see
  [the fallback ladder](/guide/fallback-ladder).
- **Your command left untouched.** Staghorn learns the port from your dev server's own
  output. portless assigns one through `PORT`, and for frameworks that ignore it (Vite,
  Astro, Angular and others) injects `--port` into the command.
- **A proxy that leaves when you do.** The daemon exits about five seconds after your
  last dev server stops, held open by a lease the OS closes however the process ends.
- **A branch in every URL, including `main`.** Every checkout is
  `<branch>.<project>.localhost`, so two clones never collide. portless adds the branch
  only in linked git worktrees.
- **Subdomain-per-tenant apps with no setup.** Any prefix above a route reaches its dev
  server by default (`acme.feature-x.myapp.localhost`). portless routes only registered
  names unless the proxy is started with `--wildcard`.
- **Node 22 LTS.** Staghorn runs on Node 20.11 and newer, including the Node 22 LTS
  line; portless requires Node 24.

## When portless fits better

- **HTTPS and HTTP/2 by default.** portless generates a local certificate authority,
  adds it to your trust store, and serves every app over HTTPS. Staghorn serves plain
  HTTP/1.1 only; `*.localhost` is already a secure context, which covers `Secure`
  cookies and service workers, but not WebAuthn or identity providers that insist on
  `https://` redirect URIs. Browsers only speak HTTP/2 over HTTPS, so the two come
  together: a dev server serving hundreds of unbundled modules loads faster over
  HTTP/2.
- **Safari.** portless keeps `/etc/hosts` in sync with your routes, so Safari resolves
  them. Staghorn's hostnames do not resolve in Safari unless you switch to a tld with
  real DNS, such as `localtest.me`. See [Known limitations](/guide/limitations#safari).
- **Starting a whole monorepo with one command.** portless can start every workspace
  package from the repo root and reads its config for each. Staghorn works under
  Turborepo too, with each package's `dev` script wrapping its own server, but it has no
  "start everything" command of its own. See
  [Monorepos and Turborepo](/guide/monorepos).
- **Sharing your dev server.** portless has Tailscale, ngrok and LAN (`.local`) modes.
  Staghorn is deliberately loopback-only.
- **A proxy that is always on.** portless can install itself as an OS startup service.

## Side by side

| | staghorn | portless |
| --- | --- | --- |
| URL | `http://<branch>.<project>.localhost` | `https://<name>.localhost` |
| Team rollout | one pull request, nothing per engineer | first-run `sudo` and CA trust on each machine |
| Root / `sudo` | never (Linux URLs carry `:4180` by default) | to bind port 443 (or use a high port) |
| Certificate authority | none | generated and trusted by default |
| `/etc/hosts` | untouched | kept in sync by default |
| HTTPS | no | yes, with HTTP/2 |
| Safari | needs a tld such as `localtest.me` | works |
| How the port is found | read from your dev server's output | assigned via `PORT` or an injected `--port` |
| Proxy lifetime | exits with your last dev server | long-running, optional OS service |
| Unregistered subdomains | routed to the parent by default | routed only with `--wildcard` |
| Monorepo / Turborepo | works per package; no "start all" command | built in, including "start all" |
| Sharing off the machine | no | Tailscale, ngrok, LAN |
| Runtime dependencies | none | none |
| Node | 20.11+ (includes 22 LTS) | 24+ |
| License | Apache-2.0 | Apache-2.0 |

## Can I use both?

Yes. By default they do not compete for a port: staghorn wants `:80`, portless `:443`.
If portless is serving plain HTTP on `:80`, staghorn sees a daemon that is not its own,
leaves it alone, and moves to its shared port `:4180` with a one-line warning. See
[the fallback ladder](/guide/fallback-ladder).

## Try it

The whole rollout is two lines in `package.json`: add `@coralogix/staghorn` as a dev
dependency and put `staghorn --` in front of your `dev` script. See
[Getting started](/guide/getting-started).

