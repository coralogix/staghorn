# @cx/staghorn

## 0.1.2

### Patch Changes

- [#8](https://github.com/coralogix/internal-staghorn/pull/8) [`6d7c630`](https://github.com/coralogix/internal-staghorn/commit/6d7c63042e925db71583a2bcc30b4946dc4c1585) Thanks [@Knat-Dev](https://github.com/Knat-Dev)! - Expose the resolved identity labels on `DevDomain`, and fix the CLI banner.

  The banner showed the raw `package.json` name as the project - ignoring a configured
  `identity.project` - and the whole route key where the branch belonged. So a consumer
  who set `project: 'cx'` saw `project coralogix`, contradicting their own config.

  The underlying gap was that `DevDomain` never exposed its resolved labels, so any
  caller wanting to display them had to re-derive them, and both obvious guesses are
  wrong. `domain.labels` now carries `{ branch, project, service }` after slugging and
  any collision suffixing.

## 0.1.1

### Patch Changes

- [#6](https://github.com/coralogix/internal-staghorn/pull/6) [`5d4739a`](https://github.com/coralogix/internal-staghorn/commit/5d4739abc7af06a25331925fadd78e0c7c7a8121) Thanks [@Knat-Dev](https://github.com/Knat-Dev)! - Fix a bug that could silently kill the host process.

  `ensureProxy` waits between spawn-poll attempts, and that wait used an unreffed
  timer. Whenever it was the only thing holding the event loop open - which is exactly
  the state of a dev-serve script that has not started its dev server yet - Node
  concluded the program was finished and exited with code 0, silently, in the middle of
  the poll. The whole point of this package is that it never breaks the caller's dev
  server, and that version broke it with no message at all.

  Found by integrating for real: every unit test injects its own `delay`, so none of
  them touched the real timer. There is now a subprocess regression test that runs
  `ensureProxy` in a bare process with nothing else on the event loop.

  Also removes a literal NUL byte that was being used as a `join()` separator in the
  route-directory fingerprint, which made that source file read as binary to grep and
  diff, and adds a check that fails the build on any control character in source.

## 0.1.0

### Minor Changes

- [#1](https://github.com/coralogix/internal-staghorn/pull/1) [`034c5b8`](https://github.com/coralogix/internal-staghorn/commit/034c5b8187d6ccad1e59b9474789c0c3abdce29a) Thanks [@Knat-Dev](https://github.com/Knat-Dev)! - Initial release.

  Gives every git branch its own localhost hostname instead of a port
  (`http://feature-x.myapp.localhost`), served by one shared unprivileged reverse proxy
  that exits when the last dev server does. Zero runtime dependencies, no sudo, no
  `/etc/hosts`, no DNS server, no certificates.

  - `staghorn -- <command>` wraps any dev server and learns its port from its output, so
    the common case needs no configuration at all.
  - Fallback ladder: wildcard `:80`, a shared high port, then direct. The hostname is
    identical on every rung, so a bookmark survives a degrade, and nothing here can stop
    a dev server from starting.
  - Programmatic `createDevDomain` / `resolveDevDomain`, a layered config model with
    per-key provenance, and `staghorn/testing` fixtures for adapter authors.
