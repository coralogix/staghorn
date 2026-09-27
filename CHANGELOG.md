# @coralogix/staghorn

## 0.1.0

Initial public release.

Every git branch gets its own localhost hostname instead of a port, via one shared
unprivileged reverse proxy. No runtime dependencies, no `sudo`, no `/etc/hosts`, no
DNS server, no certificates.

- `staghorn -- <command>` wraps a dev server you already run, learns its port from
  its output, registers the route and prints the hostname.
- One shared daemon routes by `Host` header and exits when the last dev server does,
  held open by a lease the OS closes however the process ends, including `SIGKILL`.
- A fallback ladder that never takes your dev server down: wildcard `:80`, a shared
  `:4180`, then the dev server's own port. The hostname is identical on every rung,
  so a bookmark survives a degrade.
- Optional layered configuration with per-value provenance, via
  `staghorn config --print`.
- A programmatic API (`createDevDomain`, `resolveDevDomain`) and a `staghorn/testing`
  subpath for adapter authors.
