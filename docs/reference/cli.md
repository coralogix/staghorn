# CLI

`staghorn` and `stag` are the same command.

```
staghorn -- <command>        run a dev server behind its own hostname
staghorn list [--json]       show the dev servers that are live
staghorn url [--json]        print this checkout's hostname
staghorn status [--json]     show the shared daemon
staghorn stop                stop the shared daemon
staghorn prune               drop routes whose process is gone
staghorn doctor              diagnose this machine
staghorn config --print      show the resolved config and where each value came from

--service <name>             which dev server in this checkout (app, storybook, ...)
--allocate                   choose the port instead of discovering it
--quiet                      no banner
--help, --version
```

## `staghorn -- <command>`

Runs your command unchanged, learns its port, registers the route, prints the banner and
holds a lease for as long as it lives.

Everything after `--` is your command, verbatim. staghorn does not parse it, rewrite it,
or inject flags into it.

```bash
staghorn -- npm run dev
staghorn --service storybook -- npm run storybook
staghorn --allocate -- node server.js
```

The exit code is your command's exit code. If staghorn itself cannot do its job it
degrades a rung and warns; it does not change the outcome of what it wrapped.

## `staghorn list`

The live dev servers, by host, port and branch. Routes whose process is gone are
filtered out at read time rather than shown as stale.

## `staghorn url`

This checkout's hostname, without starting anything. No daemon, no route registered, no
lease taken - it is a query, not a claim, so it is safe from a script that is still
deciding what to do.

## `staghorn status`

The shared daemon: its pid, port, protocol version, and how many routes and leases it
currently holds. The lease count is the interesting one, because it is what decides when
the daemon exits.

## `staghorn stop`

Asks the daemon to shut down. Only a daemon that answers staghorn's own control path is
ever addressed; anything else on that port is left alone.

You rarely need this - the daemon exits on its own about five seconds after the last dev
server. It exists for the deliberate "free that port now" case.

## `staghorn prune`

Drops route files whose process is gone. Reads already filter on liveness, so this is
housekeeping rather than a fix.

## `staghorn doctor`

Diagnoses this machine: platform, node version, state directory, which rungs of the
[fallback ladder](/guide/fallback-ladder) are available, and known environment problems
such as a corporate proxy that would intercept `*.localhost`.

This is the first thing to run when something is wrong, and the first thing to paste
into an issue.

## `staghorn config --print`

The resolved configuration **and the layer each value came from**. Usually faster than
reasoning about precedence by hand.

## `--json`

Works on `list`, `url`, `status` and `config`, for scripting.
