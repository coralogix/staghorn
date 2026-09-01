---
'@cx/staghorn': minor
---

Implement `daemon.mode: 'external'`, make queries side-effect free, and prove the
install layouts.

- **`daemon.mode: 'external'` never worked.** It was documented in the config types
  from the first release and `ensureProxy` spawned a daemon regardless. It now adopts a
  running daemon and otherwise falls to `direct`, spawning nothing. Exposed as
  `ensureProxy({ spawn: false })`.
- **`staghorn url` had side effects.** Asking what a URL would be started a daemon,
  registered a route, took a lease and installed exit handlers that changed how the
  host process answered Ctrl-C. New `readOnly` option does none of that, and `url` uses
  it. It also now answers with the checkout's hostname rather than
  `http://localhost:<port>` just because nothing happens to be running.
- **The install matrix is real.** Six package managers across three platforms install
  the packed tarball and smoke-test it, including Yarn PnP with zip-compressed
  dependencies - the case where `fs` is patched but `child_process` is not, so the
  daemon must be copied out to be spawnable. That path previously had unit coverage
  only; it is now verified end to end.
