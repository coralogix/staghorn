# How it works

Four parts, in order of how much you need to care.

1. **Your dev server** binds whatever port it likes. Staghorn does not care which.
2. **A route file** in `~/.staghorn/routes/` maps `feature-x.myapp` to that port. One
   file per route, so two dev servers starting at the same instant cannot lose each
   other's registration.
3. **One shared daemon** binds a single port and forwards each request to the dev
   server named by its `Host` header. WebSockets and SSE pass through untouched, so HMR
   works.
4. **A lease** keeps the daemon alive. Every dev server holds an open connection for its
   lifetime; the OS closes it however the process ends, including `SIGKILL`. When the
   last one closes, the daemon exits. It never outlives the work it was started for.

## Why no sudo

macOS (Mojave and later) allows an unprivileged process to bind a port below 1024
**only on the wildcard address** - binding `127.0.0.1:80` is still root-only. So the
daemon binds the wildcard and enforces loopback-only clients itself, at three layers: at
accept time, per request, and per upgrade.

That last part matters. The daemon is listening on a wildcard address, so the
restriction has to be its own, not the operating system's.

## Why no DNS setup

Browsers resolve `*.localhost` to loopback themselves, per
[RFC 6761](https://www.rfc-editor.org/rfc/rfc6761#section-6.3). Chrome, Firefox and Edge
implement this. **Safari does not** - see [Known limitations](/guide/limitations).

Nothing is written to `/etc/hosts`, no resolver is installed, and nothing needs to be
undone when you stop using staghorn.

## The daemon's lifetime

The daemon is a shared singleton, so its lifetime is the one thing worth understanding
properly.

It is spawned by the first dev server that needs it and exits when the last one goes
away. Two grace periods sit around that:

| | |
| --- | --- |
| **5 seconds** after the last lease closes | Long enough that restarting a dev server in place, or moving between two worktrees, reuses the running daemon instead of paying a respawn. Short enough that a finished session leaves nothing behind. |
| **30 seconds** at boot, before any lease exists | A dev server spawns the daemon and leases it a moment later. If it dies in between, or someone starts the daemon by hand, nobody will ever lease it, and it must not linger forever. |

Stopping one of several dev servers does not stop the daemon: the others still hold
leases. Only the last one out turns off the lights.

## It never touches a server it does not own

Anything answering the control port that is not Staghorn is classified `foreign` and
left strictly alone: not adopted, not shut down, not routed through. Staghorn steps down
to the next rung of the [fallback ladder](/guide/fallback-ladder) instead.

Shutting down a server you did not start is never yours to do, even on your own machine.
