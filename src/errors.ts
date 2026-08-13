/**
 * ENOENT is the only error this package routinely swallows: it means a file
 * vanished between listing and reading, which happens constantly when several
 * dev servers prune the route directory at the same time. Everything else
 * (EACCES, ENOSPC, EROFS) is a real failure and must reach a caller that can
 * report it.
 */
export function isEnoent(err: unknown): boolean {
  return errorCode(err) === 'ENOENT';
}

/** True when the error carries any of the given libuv/errno codes. */
export function hasErrorCode(err: unknown, ...codes: string[]): boolean {
  const code = errorCode(err);
  return code !== null && codes.includes(code);
}

/** The `code` of a Node system error, or null if this isn't one. */
export function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return null;
  }
  const { code } = err;
  return typeof code === 'string' ? code : null;
}

/** A human-readable message for anything that might be thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
