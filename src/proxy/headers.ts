// SPDX-License-Identifier: Apache-2.0
//
// Header handling for the forwarding paths. Pure - takes rawHeaders in, gives
// headers out.

import { HOP_BY_HOP_HEADERS } from '../protocol';

/** `rawHeaders` as [name, value] pairs, casing and order preserved. */
export function rawHeaderPairs(
  rawHeaders: readonly string[],
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

/**
 * The request-line header block for a tunnelled upgrade, rebuilt verbatim from
 * `rawHeaders`.
 *
 * Verbatim matters. Rebuilding from the parsed `headers` object - what the
 * original did - loses header casing and order, and collapses repeats with
 * `Array.isArray(v) ? v.join(', ') : v`. `, ` is the wrong separator for `Cookie`
 * (RFC 6265 says `; `), so a request carrying more than one Cookie header reached
 * the dev server with a corrupted cookie jar. An upgrade is a tunnel; the bytes
 * should arrive as they were sent.
 *
 * Hop-by-hop headers are deliberately NOT stripped here: `Connection: Upgrade`
 * and `Upgrade: websocket` are hop-by-hop and are also the entire handshake.
 */
export function upgradeRequestHead(req: {
  method?: string | undefined;
  url?: string | undefined;
  rawHeaders: readonly string[];
}): string {
  const lines = rawHeaderPairs(req.rawHeaders).map(
    ([name, value]) => `${name}: ${value}`,
  );
  const requestLine = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`;
  return `${[requestLine, ...lines].join('\r\n')}\r\n\r\n`;
}

export interface ForwardHeaderOptions {
  /** Client address, for the x-forwarded-for chain. */
  readonly remoteAddress?: string | undefined;
  /** Scheme the client used to reach the proxy. */
  readonly proto?: 'http' | 'https';
  /** Add the x-forwarded-* family. Rails/Django/Laravel need it for absolute URLs. */
  readonly forwarded?: boolean;
}

/**
 * Request headers for a plain forwarded request: repeats preserved, hop-by-hop
 * dropped, x-forwarded-* appended.
 *
 * `Host` is passed through UNCHANGED and that is load-bearing twice over - it is
 * what a dev server's host check validates against, and it is what an app parses
 * its own prefix out of. Rewriting it would break both.
 */
export function forwardRequestHeaders(
  rawHeaders: readonly string[],
  { remoteAddress, proto = 'http', forwarded = true }: ForwardHeaderOptions = {},
): Record<string, string | string[]> {
  const headers = collapse(rawHeaders, HOP_BY_HOP_HEADERS);
  if (!forwarded) {
    return headers;
  }
  const host = firstValue(headers, 'host');
  if (host !== null) {
    headers['x-forwarded-host'] = host;
  }
  headers['x-forwarded-proto'] = proto;
  if (remoteAddress) {
    const existing = firstValue(headers, 'x-forwarded-for');
    headers['x-forwarded-for'] = existing
      ? `${existing}, ${remoteAddress}`
      : remoteAddress;
  }
  return headers;
}

/**
 * Response headers to send back.
 *
 * Hop-by-hop is stripped here too, `transfer-encoding` above all: leaving the
 * upstream's value in place while Node applies its own framing produces a
 * double-chunked body. Dropping it lets Node choose, which is correct for both
 * chunked responses and SSE streams.
 */
export function forwardResponseHeaders(
  rawHeaders: readonly string[],
): Record<string, string | string[]> {
  return collapse(rawHeaders, HOP_BY_HOP_HEADERS);
}

/**
 * Fold pairs into the object shape `http.request` wants, keeping repeats as
 * arrays.
 *
 * Arrays are what preserve `Set-Cookie` correctly: several Set-Cookie headers are
 * semantically distinct and must never be joined into one value.
 */
function collapse(
  rawHeaders: readonly string[],
  drop: readonly string[],
): Record<string, string | string[]> {
  const dropped = new Set(drop);
  return rawHeaderPairs(rawHeaders).reduce<Record<string, string | string[]>>(
    (headers, [name, value]) => {
      const key = name.toLowerCase();
      if (dropped.has(key)) {
        return headers;
      }
      const existing = headers[key];
      if (existing === undefined) {
        headers[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        headers[key] = [existing, value];
      }
      return headers;
    },
    {},
  );
}

function firstValue(
  headers: Record<string, string | string[]>,
  key: string,
): string | null {
  const value = headers[key];
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
