---
'@cx/staghorn': minor
---

Add `ports.order: 'sequential'` - allocate ports from the bottom of the range instead of a route-key hash, so the first serve on a machine gets exactly `range[0]` (for ecosystems where an SSO bookmark or proxy allowlist pins that port). Allocation now also reclaims the port a checkout already holds in the registry, so restarts keep their port, and skips ports other routes have registered even before their server binds.
