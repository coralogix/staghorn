# What is Staghorn?

Staghorn gives every git branch its own localhost hostname instead of a port.

```
http://feature-x.myapp.localhost        not  http://localhost:5173
http://main.myapp.localhost             not  http://localhost:5174
http://storybook.feature-x.myapp.localhost
```

One shared daemon routes by `Host` header to the right dev server, and exits when the
last dev server does. No runtime dependencies, no `sudo`, no `/etc/hosts`, no DNS
server, no certificates.

Named after the branching coral, _Acropora cervicornis_: many branches, one skeleton.

## Why a hostname beats a port

**Stable.** The URL is a function of your branch and project, not of what order you
started things in. It stays bookmarkable across restarts. A port is assigned by
whatever got there first, so the same branch can be `5173` today and `5174` tomorrow.

**Parallel.** Several worktrees serve at once without colliding, and without anyone
having to remember that `5174` is the review branch.

**Honest cookies and origins.** `*.localhost` is a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
so `Secure` cookies, service workers and origin-sensitive APIs behave as they do in
production. Separate hostnames also mean separate cookie jars and separate
`localStorage`, so two branches cannot corrupt each other's session.

## What it is not

It is not a tunnel, a DNS server, or a TLS terminator. It does not proxy anything off
your machine: the daemon binds loopback-only and enforces that at three layers. It
does not replace your dev server, it wraps it.

## Next

- [Getting started](/guide/getting-started) - one command
- [How it works](/guide/how-it-works) - the four moving parts
- [The fallback ladder](/guide/fallback-ladder) - what happens when `:80` is taken
