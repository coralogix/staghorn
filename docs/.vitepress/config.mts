// Copyright 2026 Coralogix Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { execSync } from 'node:child_process';
import { defineConfig } from 'vitepress';

const GITHUB = 'https://github.com/coralogix/staghorn';
// Tagged so OSS-driven traffic to coralogix.com is attributable per project.
const CORALOGIX_URL =
  'https://coralogix.com/?utm_source=staghorn-docs&utm_medium=oss&utm_campaign=staghorn';
const BASE = process.env.DOCS_BASE ?? '/staghorn/';
const SITE_URL = process.env.DOCS_SITE_URL ?? `https://coralogix.github.io${BASE}`;
const DESCRIPTION =
  'Every git branch gets its own localhost hostname instead of a port, via one shared unprivileged reverse proxy. No runtime dependencies, no sudo, no /etc/hosts.';

// Releases are tag-authoritative (see .github/workflows/release.yml) - the in-repo
// package.json version is intentionally frozen, so the docs version label must come
// from the git tag, not from a hardcoded string. The release workflow passes the
// resolved version via DOCS_VERSION; otherwise we derive it from the latest local
// `vX.Y.Z` tag so local builds stay in sync too.
const VERSION = resolveVersion();

function resolveVersion(): string {
  const raw = process.env.DOCS_VERSION?.trim() || latestGitTag();
  if (!raw) return 'latest';
  return raw.startsWith('v') ? raw : `v${raw}`;
}

function latestGitTag(): string | undefined {
  try {
    return execSync("git tag --list 'v*' --sort=-v:refname", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((t: string) => t.trim())
      .find((t: string) => /^v\d+\.\d+\.\d+$/.test(t));
  } catch {
    return undefined;
  }
}

export default defineConfig({
  title: 'Staghorn',
  description: DESCRIPTION,
  base: BASE,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: SITE_URL },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}coralogix-mark.svg` }],
    ['meta', { name: 'theme-color', content: '#02763a' }],
    // Nunito Sans + Inconsolata are the Coralogix design system's families, named in
    // theme/custom.css. Served from Google Fonts rather than vendored: the design
    // system ships TTFs, several hundred kB heavier than the woff2 the CDN negotiates.
    // Without these the families in custom.css silently fall through to the defaults.
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href:
          'https://fonts.googleapis.com/css2?family=Nunito+Sans:ital,opsz,wght@0,6..12,400..800;1,6..12,400..800' +
          '&family=Inconsolata:wght@400..700&display=swap',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'Staghorn - a localhost hostname per git branch',
      },
    ],
    ['meta', { property: 'og:description', content: DESCRIPTION }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: 'Staghorn' }],
    ['meta', { name: 'twitter:description', content: DESCRIPTION }],
  ],
  themeConfig: {
    logo: { src: '/coralogix-mark.svg', width: 24, height: 24 },
    siteTitle: 'Staghorn',

    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '/reference/' },
      {
        text: VERSION,
        items: [
          { text: 'Releases', link: `${GITHUB}/releases` },
          { text: 'Contributing', link: '/contributing' },
          { text: 'npm package', link: 'https://www.npmjs.com/package/@coralogix/staghorn' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is staghorn?', link: '/guide/introduction' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'How it works', link: '/guide/how-it-works' },
          ],
        },
        {
          text: 'Usage',
          items: [
            { text: 'The hostname', link: '/guide/the-hostname' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Several dev servers', link: '/guide/services' },
          ],
        },
        {
          text: 'When it does not just work',
          items: [
            { text: 'The fallback ladder', link: '/guide/fallback-ladder' },
            { text: 'Known limitations', link: '/guide/limitations' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Programmatic API', link: '/reference/api' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: GITHUB }],

    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },

    footer: {
      message: 'Released under the Apache License 2.0.',
      copyright: [
        'Built with 💚 by',
        `<a href="${CORALOGIX_URL}" target="_blank" rel="noopener">`,
        `<img src="${BASE}coralogix-mark.svg" alt="" width="14" height="14"` +
          ' style="display:inline-block;vertical-align:-2px">',
        'Coralogix</a>',
      ].join(' '),
    },

    editLink: {
      pattern: `${GITHUB}/edit/master/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    outline: { level: [2, 3] },
  },
});
