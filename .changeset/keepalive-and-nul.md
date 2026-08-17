---
'@cx/staghorn': patch
---

Fix a bug that could silently kill the host process.

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
