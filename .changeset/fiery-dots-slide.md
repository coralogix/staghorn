---
'@cx/staghorn': minor
---

Initial release.

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
