# Configuration

None is required. When you want it, `staghorn.config.ts` (or `.mjs`, `.json`, or a
`staghorn` key in `package.json`):

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

## Layers

Low to high: defaults, user config, project config, `STAGHORN_*` environment, CLI flags,
programmatic options, and finally the `overrides` block of the **user** config.

That last one is deliberate. It means a developer's machine can always beat their team's
project config - the person on Safari, or the one whose corporate software owns `:80`,
does not have to argue with a committed file.

```bash
npx staghorn config --print
```

shows the resolved config **and where every single value came from**, which is usually
faster than reasoning about the precedence rules.

## Environment variables

These mirror the config keys:

| Variable | Effect |
| --- | --- |
| `STAGHORN_DISABLE` | Turn staghorn off entirely; your command runs untouched |
| `STAGHORN_TLD` | Override the tld |
| `STAGHORN_MODE` | Force a rung of the fallback ladder |
| `STAGHORN_PORT` | Force the proxy port |
| `STAGHORN_PROJECT` | Override the project label |
| `STAGHORN_STATE_DIR` | Move `~/.staghorn` elsewhere |
| `STAGHORN_LOG` | Log level |

`STAGHORN_DISABLE` is the one to remember. It is the escape hatch for CI, for a
teammate who wants nothing to do with this, and for bisecting whether staghorn is
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
