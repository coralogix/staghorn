# The fallback ladder

Staghorn never fails in a way that stops your dev server. If a rung is unavailable it
takes the next one and prints one line saying so.

**The hostname is identical on every rung** - only the port appears - so a bookmark
survives a degrade.

| Rung | You get | When |
| --- | --- | --- |
| wildcard `:80` | `http://feature-x.myapp.localhost` | macOS, most Windows, Linux with a sysctl |
| shared `:4180` | `http://feature-x.myapp.localhost:4180` | Linux by default; anything already owns `:80` |
| direct | `http://localhost:5173` | no daemon could start at all |

## Linux

Linux is fully supported and lands on the shared port by default. You lose the cosmetic
port-free URL and keep everything that matters: a stable name that never drifts, and one
constant port for every checkout.

To get rung 1 on Linux:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
```

## Why it degrades rather than fails

Staghorn wraps a dev server someone is actively working in. A convenience layer that can
take that down is worse than no convenience layer, so every failure path ends at a lower
rung rather than at an exception.

The `direct` rung is not a degraded mode so much as the floor: it is your dev server's
own address, which was always going to work. Staghorn printing it means Staghorn got out
of the way.

## Why a foreign server never gets adopted

If something is already listening and it is not Staghorn, the daemon does not try to
share the port, shut it down, or route through it. It steps down a rung.

This is the behaviour you want the one time it matters: the thing on `:80` is nginx
serving something you care about, and a dev tool deciding to be clever about it would be
a very bad afternoon.
