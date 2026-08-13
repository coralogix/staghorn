# Contributing

## Getting set up

```bash
npm install
npm test          # unit + integration, no privileged ports needed
npm run typecheck
npm run build
npm run check:pkg # publint + are-the-types-wrong against a real npm pack
```

Node 20.11 or newer. There are no runtime dependencies and there never should be - see
below.

## Design constraints

These are not preferences. Changes that break them will be asked to change.

**No runtime dependencies.** The package installs into every developer's dev loop, so
its supply chain is their supply chain. `node:` builtins only. If you need a
dependency, the feature probably belongs in an adapter package instead.

**Nothing may break a developer's dev server.** `ensureProxy` and `createDevDomain`
degrade rather than throw: a missing daemon, an occupied port, an unreadable state dir
and a failed spawn all resolve to a lower rung with one explanatory line. A dev tool
that can take down the thing it wraps has negative value.

**Everything is injected.** No module-level mutable state, and nothing runs at import
time. `createProxy(options, deps)` takes its state store, clock, logger, trust
predicate and socket factories as arguments; `run(io)` takes the CLI's argv, env, cwd
and streams. This is why the daemon and the CLI are testable at all - the version this
was extracted from ran `main()` on import and kept its routing table in
module-level `let`s, and consequently had no tests for either.

**No test binds a privileged port.** The daemon's listen address is configuration, so
every test uses an ephemeral port and runs unprivileged on all three platforms. There
is exactly one platform-gated test that binds `:80`, and it exists to assert a claim
about macOS, not about our code.

**Never touch a daemon you do not own.** Routes and daemons carry a uid. A daemon
belonging to another user is never adopted, leased or stopped. On a shared machine the
alternative is killing a colleague's dev environment.

## Tests

- `src/**/*.test.ts` - unit and integration, run by `npm test`.
- Integration tests use real sockets on ephemeral ports and a real `git` for repo
  fixtures. Real git rather than a mock, because the identity layer exists to answer
  questions about detached HEADs, linked worktrees and bare repos, and a mock would
  only confirm what its author already believed.
- `staghorn/testing` exports the fixtures (`createTempState`, `createGitFixture`,
  `createFakeUpstream`, `createFakeClock`). Use them rather than writing to a real
  state directory - a test that touches `~/.staghorn` will eventually delete someone's
  routes.

## Changesets

Every user-visible change needs one:

```bash
npm run changeset
```

Pick `patch` for fixes, `minor` for features **and for breaking changes while we are
pre-1.0**. CI reminds you if a changeset is missing but does not block on it - a hard
gate on a first contribution is hostile.

## Two versions, and they move independently

The npm version and the **protocol version** (`PROTOCOL_VERSION` in `src/protocol.ts`)
are not the same thing. Bump the protocol whenever you change:

- the `/status` payload shape,
- the lease protocol,
- routing behaviour.

A package *patch* may carry a protocol bump. Getting this wrong makes a stale daemon
look newer than a fresh one and silences the warning that tells a developer to restart
it. Mismatched protocol majors deliberately refuse to share a port; the newer client
ladders down instead.

## Commits

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Signed commits
are required by repository rules. Keep one concern per commit.
