# Configuration

None is required. When you want it, `staghorn.config.ts` (or `.mts`, `.mjs`, `.js`,
`.cjs`, `.json`, or a `staghorn` key in `package.json`):

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

::: tip TypeScript config needs a Node that strips types
A `.ts` or `.mts` config is imported directly, with no bundler in between. That works
out of the box on Node 22.18+ and 23.6+, and on Node 22.6+ with
`--experimental-strip-types`. On older Node, name the file `staghorn.config.mjs`: the
contents are the same, and Staghorn's error message says so if it cannot load a `.ts`.
:::

## Layers

Low to high: defaults, user config, project config, `STAGHORN_*` environment, CLI flags,
programmatic options, and finally the `overrides` block of the **user** config.

That last one is deliberate. It means a developer's machine can always beat their team's
project config - the person on Safari, or the one whose corporate software owns `:80`,
does not have to argue with a committed file.

```bash
npx @coralogix/staghorn config --print
```

shows the resolved config **and where every single value came from**, which is usually
faster than reasoning about the precedence rules.

## Environment variables

These mirror the config keys:

| Variable | Effect | Accepted values |
| --- | --- | --- |
| `STAGHORN_DISABLE` | Turn Staghorn off entirely; your command runs untouched | `1` or `true` |
| `STAGHORN_TLD` | Override the tld | any tld, e.g. `localtest.me` |
| `STAGHORN_MODE` | Force a rung of the fallback ladder | `auto`, `wildcard`, `sharedPort`, `direct` |
| `STAGHORN_PORT` | Pin the **dev server's** port (`ports.strategy: 'fixed'`) | a port number |
| `STAGHORN_PROJECT` | Override the project label | a label, or `false` to drop it |
| `STAGHORN_STATE_DIR` | Move `~/.staghorn` elsewhere | a directory path |
| `STAGHORN_LOG` | Log level | `silent`, `error`, `warn`, `info`, `debug` |

An unrecognised value is ignored rather than guessed at, so `STAGHORN_DISABLE=yes` does
nothing. `staghorn config --print` shows whether a variable took effect.

`STAGHORN_DISABLE` is the one to remember. It is the escape hatch for CI, for a
teammate who wants nothing to do with this, and for bisecting whether Staghorn is
involved in a problem at all.

## Ports

```ts
ports: { strategy: 'allocate', order: 'sequential', range: [4200, 4999] }
```

`discover` (the default) learns the port from your dev server's output. `allocate`
picks one up front, for a dev server that needs to be told rather than asked.
`fixed` pins it.

With `allocate`, `order: 'hash'` derives a stable port from the route key so each
checkout tends to keep its own across restarts. `order: 'sequential'` starts at the
bottom of the range instead, which matters when something external pins a specific port:
an SSO bookmark, a proxy allowlist, an OAuth redirect URI.

Either way a checkout reclaims the port it already holds in the registry, so restarts
keep their port.

## What your dev server receives

The wrapped command inherits your environment plus:

| Variable | Value |
| --- | --- |
| `STAGHORN_HOST` | The printed hostname, e.g. `feature-x.myapp.localhost` |
| `STAGHORN_ORIGIN` | The same as an origin, e.g. `http://feature-x.myapp.localhost` |
| `STAGHORN_ROUTE` | The route key, e.g. `feature-x.myapp` |
| `STAGHORN_PORT` | The dev server's port |
| `STAGHORN_MODE` | The rung it landed on |
| `PORT` | The allocated port, with `--allocate` only |

`--allocate` only helps a dev server that reads `PORT`. Many do (Next.js, most Express
apps); Vite does not, so point it at the variable yourself:

```ts
// vite.config.ts
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
});
```

For anything else your app needs, `rewrite.env` adds variables of your own.

