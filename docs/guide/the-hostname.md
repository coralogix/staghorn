# The hostname

```
[<prefix>.]{<service>.}<branch>.<project>.<tld>
     ^          ^           ^        ^
 anything    optional    slugged   grouping label
 your app    per-server   branch
 wants
```

## The project label

On by default, and not cosmetic. Every project has a `main`; without the project label,
two checkouts collide and get order-dependent `-2` suffixes that flip between boots,
which makes URLs unbookmarkable and ports unstable.

Set `identity.project: false` to flatten it away if you only ever run one project.

## Routing is longest-suffix match

A service route beats the app route beneath it, and any prefix your app wants above it
is ignored:

```
team-a.storybook.feature-x.myapp.localhost  ->  storybook.feature-x.myapp
team-a.feature-x.myapp.localhost            ->  feature-x.myapp
```

That is what lets an app use subdomains of its own - per-tenant, per-team, per-locale -
on top of a Staghorn hostname without Staghorn having to know anything about them.

## Branch slugging

The branch name is flattened to a legal DNS label: lowercased, non-alphanumerics
collapsed to hyphens, truncated to fit inside the 63-character label limit and the
253-character hostname limit.

`feature/CX-1234_add-thing` becomes `feature-cx-1234-add-thing`.

If two checkouts would slug to the same label, the second is disambiguated rather than
silently stealing the first one's route.

## Seeing what you will get

```bash
npx staghorn url
```

prints this checkout's hostname without starting anything: no daemon, no route
registered, no lease taken. It is a query, not a claim, so it is safe to call from a
script that is deciding what to do.
