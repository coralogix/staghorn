# Programmatic API

For a repo that already owns its dev script and wants the hostname without the CLI
wrapping it.

```ts
import { createDevDomain } from '@coralogix/staghorn';

const domain = await createDevDomain({ ports: { strategy: 'allocate' } });
await startMyServer(domain.port, { origin: domain.origin });
domain.printBanner();

// If your server ended up on a different port than requested:
await domain.setPort(actualPort);
```

## `createDevDomain(options)`

Resolves the identity, starts or adopts the daemon, registers the route and takes a
lease. Returns a `DevDomain` carrying the resolved `host`, `port`, `origin` and `mode`
(which rung of the [fallback ladder](/guide/fallback-ladder) it landed on).

`setPort` exists because a dev server does not always take the port you asked for. Call
it and the registry is corrected rather than left describing something that is not true.

## `resolveDevDomain(options)`

Answers what **would** happen, with no side effects at all: no registry write, no spawn,
no lease. For a script that wants to decide before committing to anything.

```ts
import { resolveDevDomain } from '@coralogix/staghorn';

const plan = await resolveDevDomain();
console.log(plan.host, plan.mode);
```

## Port strategy

```ts
const domain = await createDevDomain({
  ports: { strategy: 'allocate', order: 'sequential', range: [4200, 4999] },
});
```

Allocation picks a stable hash of the route key by default, so each checkout tends to
keep its own port. When something external pins a specific port - an SSO bookmark, a
proxy allowlist - allocate sequentially instead, so the first serve on a machine gets
exactly the bottom of the range.

Either way a checkout reclaims the port it already holds in the registry, so restarts
keep their port.

## `@coralogix/staghorn/config`

```ts
import { defineConfig } from '@coralogix/staghorn/config';
```

`defineConfig` is identity with types attached. Also exports `loadConfig`,
`configFromEnv`, `DEFAULT_CONFIG` and `CONFIG_FILENAMES` for tooling that needs to
resolve Staghorn's configuration the same way Staghorn does.

## `@coralogix/staghorn/testing`

Fixtures for anyone writing an adapter, so their tests do not touch a real state
directory:

| Export | What it gives you |
| --- | --- |
| `createTempState()` | An isolated state dir, plus the env that points Staghorn at it |
| `createGitFixture()` | A throwaway git repo, with worktrees and detached-HEAD support |
| `createFakeUpstream()` | A server that records the requests it received |
| `createFakeClock()` | Time you control |
| `createRecordingLogger()` | A logger you can assert against |

`createTempState` returns the env rather than mutating `process.env`, so parallel tests
do not fight over a global.

::: warning
A test that writes to the real `~/.staghorn` will eventually delete someone's routes.
Use these.
:::

## Stability

`@coralogix/staghorn` exports a wide surface, much of it the internals the CLI is built
from. Treat `createDevDomain`, `resolveDevDomain`, `defineConfig` and the
`@coralogix/staghorn/testing` fixtures as the supported API. Anything else may change in
a minor release while the package is pre-1.0.
