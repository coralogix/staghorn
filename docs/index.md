---
layout: home

hero:
  name: Staghorn
  text: A localhost hostname per git branch
  tagline: >-
    Two branches running, and you can never remember which one is on 5173. Logging
    into one clobbers the session in the other, because cookies ignore the port.
    Staghorn gives every branch its own hostname instead: one shared reverse proxy,
    no runtime dependencies, no sudo.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Staghorn?
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/coralogix/staghorn

features:
  - title: Wrap what you already run
    details: >-
      npx @coralogix/staghorn -- npm run dev. It runs your command unchanged, learns the real
      port from its output, registers the route and prints the hostname. No config
      file, no code change, no --port plumbing.
  - title: Stable, not order-dependent
    details: >-
      The URL is a function of your branch and project, not of what order you started
      things in. It stays bookmarkable across restarts, and several worktrees serve at
      once without colliding.
  - title: Honest cookies and origins
    details: >-
      *.localhost is a secure context, so Secure cookies, service workers and
      origin-sensitive APIs behave as they do in production. Separate hostnames mean
      separate cookie jars, so two branches cannot corrupt each other's session.
  - title: Works for subdomain-per-tenant apps
    details: >-
      An app that reads a tenant, team or workspace off the host cannot be exercised
      on localhost:5173 at all. Any prefix above the route reaches the same dev
      server, so acme.feature-x.myapp.localhost just works, with no /etc/hosts, no
      dnsmasq and no local Caddy to keep up to date.
  - title: It never takes your dev server down
    details: >-
      A fallback ladder degrades rung by rung and says so in one line. The hostname is
      identical on every rung, so a bookmark survives a degrade.
---
