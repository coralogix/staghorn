# Several dev servers

A checkout usually runs more than one thing: the app, Storybook, a mock API. Each gets
its own subdomain under the same branch hostname, routed by the same daemon.

```bash
npx @coralogix/staghorn --service storybook -- npm run storybook
```

```
  ▸ project  myapp
  ▸ branch   feature-x
  ▸ service  storybook
  ▸ url      http://storybook.feature-x.myapp.localhost
  ▸ direct   http://localhost:6006   (always works)
```

Run it alongside your app and both are live at once:

```
http://feature-x.myapp.localhost              the app
http://storybook.feature-x.myapp.localhost    Storybook
```

One daemon, two routes, two leases. It exits when **both** are gone.

## Declaring them in config

If the same set runs every time, name them once:

```ts
export default defineConfig({
  services: {
    app: {},
    storybook: { subdomain: 'storybook' },
    api: { subdomain: 'api' },
  },
});
```

The service name and the subdomain are separate on purpose: the name is what you pass to
`--service`, the subdomain is what appears in the hostname. They are usually the same,
and occasionally you want them not to be.

## Why this works

Routing is a longest registered suffix match, so `storybook.feature-x.myapp` wins over
`feature-x.myapp` for any request whose Host starts with it. See
[The hostname](/guide/the-hostname).

That also means adding a service never disturbs the app's route. They are siblings, not
a hierarchy.
