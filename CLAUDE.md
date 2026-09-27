# CLAUDE.md

Context for AI agents working in this repo. Durable facts only; anything that changes
per task belongs in the task, not here.

## What this is

A CLI and library that gives each git branch its own localhost hostname instead of a
port, by routing through one shared unprivileged reverse proxy. Published as
`@coralogix/staghorn`. Node only, no framework.

## Commands

```bash
npm test              # vitest, the whole suite
npm run typecheck     # tsc --noEmit
npm run build         # tsup -> dist/
npm run check:pkg     # publint + are-the-types-wrong against a real npm pack
npm run check:scrub   # blocks internal names, tickets, credentials
npm run license:check # every source file carries the Apache header
npm run license:fix   # adds missing ones
```

Before pushing, all six pass. CI runs the same set plus a 3-OS test matrix and a
6-package-manager install matrix.

## Invariants

These are not style preferences. Breaking one is a bug even if tests pass.

- **Zero runtime dependencies.** Anything in `dependencies` is a defect. Dev
  dependencies are fine.
- **Nothing may take a dev server down.** staghorn wraps someone's dev server; a
  failure degrades to a lower rung on the fallback ladder and warns. It never throws
  into the wrapped process.
- **Everything is injected.** Clock, logger, filesystem paths, liveness checks, the
  port prober. That is what makes the suite runnable without sockets or daemons.
- **No test binds a privileged port.** The listen address is configuration, so every
  case runs unprivileged on macOS, Linux and Windows alike.
- **Never touch a daemon you do not own.** Anything answering the control port that
  is not ours is classified `foreign` and left alone: not adopted, not shut down.
- **Nothing Coralogix-specific.** The consuming monorepo owns its own URL shape,
  credentials and entry routes. `scripts/scrub-check.mjs` enforces this on every
  commit, and its allowlist is deliberately tiny.

## Two versions, moving independently

`PROTOCOL_VERSION` in `src/protocol.ts` is the wire contract between daemon and
clients. It is not the package version. Bump it for any change to the `/status`
shape, the lease protocol, or routing behaviour. A package patch may carry a protocol
bump. Mismatched protocol majors deliberately refuse to share a port.

## Releases

`package.json`'s `version` is frozen at `0.0.0` on purpose. The Release workflow
resolves the next version from the latest `v*` git tag, stamps it into the package
inside the runner **before the build** (tsup bakes it in at build time), publishes via
npm trusted publishing, and pushes only a tag. Nothing is ever committed to `main`.

## Layout

- `src/cli/` - argv parsing and the subcommands; `bin.ts` is the only place that
  touches the real process
- `src/proxy/` - the daemon: routing, leases, error pages
- `src/state/` - the route registry, one file per route under `~/.staghorn/routes/`
- `src/identity/` - branch and project to DNS label
- `src/ports/` - allocation and probing
- `src/config/` - the layered config loader, with per-value provenance
- `src/testing/` - published fixtures for adapter authors
