# Monorepos and Turborepo

Staghorn wraps one dev server per invocation, so a monorepo wraps each package's own
`dev` script. Your task runner starts them as usual, and every package gets its own
hostname behind the same daemon.

## One project, one service per package

Name the project once, at the repo root, in `staghorn.config.json`:

```json
{ "identity": { "project": "acme" } }
```

Then give each package's `dev` script a service name. In `packages/web/package.json`:

```json
{ "scripts": { "dev": "staghorn --service web -- vite" } }
```

and in `packages/api/package.json`:

```json
{ "scripts": { "dev": "staghorn --service api -- node server.mjs" } }
```

Every package shares one parent domain per branch:

```
http://web.feature-x.acme.localhost
http://api.feature-x.acme.localhost
```

Sharing a parent domain is what lets a session cookie scoped to
`feature-x.acme.localhost` reach both the app and its API, as it would in production.

Without the root config, each package is its own project, named after its
`package.json`: `feature-x.web.localhost` and `feature-x.api.localhost`. That works, but
the two share no parent domain.

## Turborepo

Nothing Staghorn-specific is needed in `turbo.json`. Mark `dev` as persistent and
uncached, as for any long-running task:

```json
{
  "tasks": {
    "dev": { "cache": false, "persistent": true }
  }
}
```

`turbo run dev` then starts every package through its own `staghorn --` wrapper:

- **Ports can collide and it still works.** Staghorn reads each dev server's real port
  from its output, so a Vite server that moves from 5173 to 5174 because something else
  took 5173 is still routed correctly.
- **Nothing prompts.** Staghorn never asks for input, so it is safe under a task runner
  that gives it no terminal.
- **Starting in parallel is safe.** Every route is its own file, so packages starting at
  the same instant cannot lose each other's registration.
- **Ctrl+C stops everything.** Each dev server exits, its route disappears, and the
  daemon exits once the last one is gone.

## Rolling it out

Add `@coralogix/staghorn` as a dev dependency at the repo root, put the config file next
to it, and prefix each package's `dev` script. That is the whole change; nobody on the
team has to set anything up on their own machine.
