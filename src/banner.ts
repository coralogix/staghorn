// SPDX-License-Identifier: Apache-2.0
//
// Rendering the URLs a developer actually reads.

import type { LabelledUrl } from './config/types';

// Built from char codes rather than written as literal control characters: the
// literals work, but they are invisible in a diff and one editor's
// "trim whitespace" pass silently breaks them.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CYAN = `${ESC}[36m`;
const CYAN_OFF = `${ESC}[39m`;

/**
 * Render a URL the way dev servers do: cyan, wrapped in an OSC 8 terminal
 * hyperlink so it stays clickable even when a terminal's regex linkifier gives up -
 * which it does exactly on the long multi-label hosts this tool produces.
 *
 * Supported by iTerm2, VS Code, kitty, WezTerm, Ghostty and Windows Terminal;
 * others consume the escapes and show plain cyan. Skipped entirely when stdout is
 * not a TTY, so piped and logged output stays clean.
 */
export function terminalLink(url: string, isTty = process.stdout.isTTY): string {
  if (!isTty) {
    return url;
  }
  return `${ESC}]8;;${url}${BEL}${CYAN}${url}${CYAN_OFF}${ESC}]8;;${BEL}`;
}

export interface BannerInput {
  readonly project: string | null;
  readonly branch: string;
  readonly service: string | null;
  readonly urls: readonly LabelledUrl[];
  /** Always shown, because it works even when everything else degraded. */
  readonly directOrigin: string;
  readonly note?: string | null;
  readonly isTty?: boolean;
}

/**
 * The banner.
 *
 * The direct URL is always printed alongside the pretty one. That is deliberate: a
 * developer whose proxy just degraded, or whose browser does not resolve the tld,
 * should never have to go looking for the address that definitely works.
 */
export function renderBanner({
  project,
  branch,
  service,
  urls,
  directOrigin,
  note,
  isTty = process.stdout.isTTY,
}: BannerInput): string {
  const rows: Array<[string, string]> = [];
  if (project) {
    rows.push(['project', project]);
  }
  rows.push(['branch', branch]);
  if (service) {
    rows.push(['service', service]);
  }
  for (const { label, url } of urls) {
    rows.push([label, terminalLink(url, isTty)]);
  }
  rows.push(['direct', `${terminalLink(directOrigin, isTty)}   (always works)`]);

  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const lines = rows.map(
    // A printable character, unlike ESC/BEL above, so it stays a literal.
    ([label, value]) => `  ▸ ${label.padEnd(width)}  ${value}`,
  );
  if (note) {
    lines.push('', `  ${note}`);
  }
  return lines.join('\n');
}
