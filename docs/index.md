---
layout: home

hero:
  name: staghorn
  text: A localhost hostname per git branch
  tagline: >-
    Every branch gets a stable, bookmarkable URL instead of a port that changes
    between sessions. One shared reverse proxy, no runtime dependencies, no sudo.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is staghorn?
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/coralogix/staghorn

features:
  - title: Wrap what you already run
    details: >-
      npx staghorn -- npm run dev. It runs your command unchanged, learns the real
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
  - title: It never takes your dev server down
    details: >-
      A fallback ladder degrades rung by rung and says so in one line. The hostname is
      identical on every rung, so a bookmark survives a degrade.
---
