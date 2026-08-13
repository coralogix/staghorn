// The pages a developer actually sees when routing fails. Pure.

/**
 * Nothing from the REQUEST is ever echoed into these pages - not the path, not
 * the Host header. A page says what to do next rather than parroting what was
 * sent, so there is no reflection to get wrong. The one interpolated value is a
 * branch name out of the registry, and branch names may legally contain `<`, `>`
 * and `"`, so it is escaped anyway.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export type ErrorPageKind = 'no-route-on-host' | 'route-not-registered' | 'upstream-down';

export interface ErrorPageInfo {
  readonly kind: ErrorPageKind;
  readonly status: 404 | 502;
  /** Branch of the route involved, when there is one. */
  readonly branch?: string | null;
  /** Port the dead upstream was expected on. */
  readonly port?: number | null;
  /** The command that lists live dev servers, resolved for the consumer's setup. */
  readonly listCommand: string;
}

export type ErrorPageRenderer = (info: ErrorPageInfo) => string;

/**
 * The default renderer. Consumers can replace it wholesale - a team with its own
 * dev portal would rather link there than describe a CLI.
 */
export const renderErrorPage: ErrorPageRenderer = (info) => {
  const hint = `<p>Run <code>${escapeHtml(info.listCommand)}</code> to see the dev servers that are currently live.</p>`;
  return page(bodyFor(info) + hint);
};

function bodyFor(info: ErrorPageInfo): string {
  if (info.kind === 'upstream-down') {
    const which = info.branch
      ? ` for <code>${escapeHtml(info.branch)}</code>`
      : '';
    const where = info.port ? ` (port ${info.port})` : '';
    return `<p>The dev server${which}${where} is not responding. Is it still running?</p>`;
  }
  if (info.kind === 'route-not-registered') {
    return '<p>No dev server is registered for this host. It may have stopped, or its checkout may be gone.</p>';
  }
  return '<p>Nothing is served on this host. Each dev server lives on its own subdomain.</p>';
}

function page(body: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>staghorn</title>' +
    '<meta name="color-scheme" content="light dark">' +
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">' +
    `<h1 style="font-size:1.25rem">staghorn</h1>${body}</body>`
  );
}
