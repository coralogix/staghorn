---
'@cx/staghorn': patch
---

Expose the resolved identity labels on `DevDomain`, and fix the CLI banner.

The banner showed the raw `package.json` name as the project - ignoring a configured
`identity.project` - and the whole route key where the branch belonged. So a consumer
who set `project: 'cx'` saw `project coralogix`, contradicting their own config.

The underlying gap was that `DevDomain` never exposed its resolved labels, so any
caller wanting to display them had to re-derive them, and both obvious guesses are
wrong. `domain.labels` now carries `{ branch, project, service }` after slugging and
any collision suffixing.
