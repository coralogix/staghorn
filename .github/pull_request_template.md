## What and why

<!-- What changes, and what problem it solves. The release notes are generated from
     pull request titles, so a reader should be able to tell from yours alone. -->

## Checklist

These are the CI gates, listed so you can fail fast locally rather than in review.

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run license:check` passes (`npm run license:fix` adds missing headers)
- [ ] `npm run check:scrub` passes
- [ ] `npm run check:pkg` passes, if you touched `exports`, `files` or the build

## Things reviewers look for here

- [ ] **No runtime dependencies added.** This is a hard invariant, not a preference.
- [ ] **Nothing may take a dev server down.** A failure in staghorn degrades to a
      lower rung; it never propagates to the process it wraps.
- [ ] **`PROTOCOL_VERSION` bumped** if you changed the `/status` shape, the lease
      protocol, or routing. It moves independently of the package version.
- [ ] **No test binds a privileged port.** The listen address is configuration, so
      every case can run unprivileged on every platform.
