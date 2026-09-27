# Getting started

## Wrap what you already run

```bash
npx staghorn -- npm run dev
```

```
  ▸ project  myapp
  ▸ branch   feature-x
  ▸ url      http://feature-x.myapp.localhost
  ▸ direct   http://localhost:5173   (always works)

  VITE v6.0.0  ready in 412 ms
```

No config file, no code change, no `--port` plumbing. staghorn ran your command
unchanged, learned the real port from its output, registered the route and printed the
hostname.

Open the `url` line. The `direct` line is your dev server's own address, printed so you
always have a way in even if something about the proxy is wrong on your machine.

## Install it

Running through `npx` is fine, but a project that uses staghorn should depend on it so
everyone gets the same version:

```bash
npm install -D @coralogix/staghorn
```

```json
{
  "scripts": {
    "dev": "staghorn -- vite"
  }
}
```

`staghorn` and `stag` are the same command.

## Requirements

Node 20.11 or newer. Installs cleanly under npm, pnpm, yarn (including PnP) and bun -
each of those is covered by CI on Linux, macOS and Windows.

## Check your machine

```bash
npx staghorn doctor
```

```
staghorn 0.1.0

platform    darwin (node 24.15.0)
state dir   /Users/you/.staghorn
daemon log  /Users/you/.staghorn/proxy.log
:80         free
:4180       free
```

`doctor` is the first thing to run, and the first thing to paste into an issue. It
reports which rungs of the [fallback ladder](/guide/fallback-ladder) are available and
flags machine-specific problems like a corporate proxy intercepting `*.localhost`.

## See what is running

```bash
npx staghorn list
```

```
HOST                            PORT  BRANCH      URL
feature-x.myapp.localhost       5173  feature-x   http://feature-x.myapp.localhost
storybook.feature-x.myapp.local 6006  feature-x   http://storybook.feature-x.myapp...
```

`--json` works here, and on `url`, `status` and `config`.

## Next

- [How it works](/guide/how-it-works)
- [The hostname](/guide/the-hostname) - what each label means
- [Several dev servers](/guide/services) - Storybook alongside your app
