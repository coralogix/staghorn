# Contributing

Contributions are welcome. The full contributor guide lives in the repo alongside the
code:

- **[CONTRIBUTING.md](https://github.com/coralogix/staghorn/blob/master/CONTRIBUTING.md)** — dev setup, design constraints, tests, releases.
- **[CLA.md](https://github.com/coralogix/staghorn/blob/master/CLA.md)** — the Coralogix Contributor License Agreement, enforced by CLA Assistant on your first pull request.
- **[SECURITY.md](https://github.com/coralogix/staghorn/blob/master/SECURITY.md)** — reporting vulnerabilities responsibly.

## Quick dev loop

```bash
npm install
npm test             # vitest, the whole suite
npm run typecheck    # tsc --noEmit
npm run build        # tsup -> dist/
npm run check:pkg    # publint + are-the-types-wrong, against a real npm pack
npm run check:scrub  # blocks internal names, tickets and credentials
npm run license:check # every source file carries the Apache header
```

All six run in CI, plus a three-OS test matrix and an install matrix covering npm, pnpm,
yarn (node-modules and PnP) and bun.

`npm run license:fix` adds any missing headers for you.

## Design constraints

These are not style preferences. Breaking one is a bug even if the tests pass.

- **Zero runtime dependencies.** Anything in `dependencies` is a defect.
- **Nothing may take a dev server down.** Staghorn wraps someone's working dev server; a
  failure degrades a rung and warns, it never throws into the wrapped process.
- **Everything is injected** — clock, logger, paths, liveness checks, the port prober.
  That is what makes the suite runnable without sockets or daemons.
- **No test binds a privileged port.** The listen address is configuration, so every case
  runs unprivileged on every platform.
- **Never touch a daemon you do not own.** Anything answering the control port that is
  not Staghorn is left strictly alone.

## The docs site

```bash
npm run docs:dev      # local preview with hot reload
npm run docs:build    # what CI publishes
```

The site is published to GitHub Pages from `master`.
