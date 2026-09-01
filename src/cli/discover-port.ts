// SPDX-License-Identifier: Apache-2.0
//
// Learning a dev server's real port from its output.
//
// This is what makes the primary invocation need no configuration:
//
//   npx staghorn -- npm run dev
//
// The alternative - allocate a port and require the consumer to bind it - forces
// `--port {{port}}` into their command, which means every consumer has to know
// which flag their dev server uses. Worse, it cannot see the truth: a dev server
// whose chosen port is taken silently moves to the next one, and the predecessor's
// registry then pointed at a port nobody was listening on.

/**
 * Matches the port in a URL printed by a dev server, covering the bracketed IPv6
 * form as well as hostnames.
 *
 * Anchored on `://` rather than just a colon so it cannot mistake a timestamp
 * (`12:34`), a version (`1:2`), or a ratio in a log line for a port.
 */
export const DEFAULT_PORT_PATTERN =
  /https?:\/\/(?:\[[0-9a-f:.]+\]|[\w.-]+):(\d{2,5})/i;

export interface PortScanner {
  /** Feed a chunk of child output. Returns a port the first time one is seen. */
  push(chunk: string): number | null;
  readonly found: number | null;
}

export interface PortScannerOptions {
  readonly pattern?: RegExp | false;
  /**
   * Ports to disregard - notably the proxy's own, which appears in our banner and
   * would otherwise be scraped back in as if it were the dev server's.
   */
  readonly ignore?: readonly number[];
}

export function createPortScanner({
  pattern = DEFAULT_PORT_PATTERN,
  ignore = [],
}: PortScannerOptions = {}): PortScanner {
  let found: number | null = null;
  // Output arrives in arbitrary chunks, so a URL can be split across two of them.
  // A small tail is carried over rather than the whole stream being buffered.
  let tail = '';
  const ignored = new Set(ignore);

  return {
    push: (chunk) => {
      if (found !== null || pattern === false) {
        return null;
      }
      const text = tail + chunk;
      // EVERY match is considered, not just the first. An ignored port stays in the
      // carry-over tail, so stopping at the first match would make the scanner
      // re-reject the same URL forever and never reach the real one behind it.
      //
      // A fresh regex each call, because a caller-supplied global pattern carries
      // lastIndex between uses; `y` is stripped since it would anchor matching to
      // that index.
      const matcher = new RegExp(
        pattern.source,
        `${pattern.flags.replace(/[gy]/g, '')}g`,
      );
      for (const match of text.matchAll(matcher)) {
        const raw = match[1];
        if (raw === undefined) {
          continue;
        }
        const port = Number.parseInt(raw, 10);
        if (port > 0 && port <= 65_535 && !ignored.has(port)) {
          found = port;
          tail = '';
          return port;
        }
      }
      tail = text.slice(-200);
      return null;
    },
    get found() {
      return found;
    },
  };
}
