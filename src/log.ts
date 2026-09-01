// SPDX-License-Identifier: Apache-2.0
//
// Logging is an injected dependency everywhere, never a direct console call.
// The daemon writes to a file, the CLI writes to a TTY, tests capture, and an IDE
// integration wants structured records - all four are the same code path.

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly msg: string;
  readonly data?: unknown;
}

export interface Logger {
  error(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives every record at or below `level`. Defaults to a `[staghorn]` console writer. */
  sink?: (record: LogRecord) => void;
  /** Prefix for the default sink. */
  prefix?: string;
}

export function createLogger({
  level = 'info',
  sink,
  prefix = 'staghorn',
}: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[level];
  const write = sink ?? consoleSink(prefix);

  const at = (recordLevel: Exclude<LogLevel, 'silent'>) => {
    return (msg: string, data?: unknown): void => {
      if (LEVEL_ORDER[recordLevel] > threshold) {
        return;
      }
      write(data === undefined ? { level: recordLevel, msg } : { level: recordLevel, msg, data });
    };
  };

  return {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
  };
}

/** A logger that records everything, for assertions in tests. */
export function createRecordingLogger(): Logger & {
  readonly records: readonly LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (record) => records.push(record),
  });
  return { ...logger, records };
}

/** Drops everything. The default inside library code that must stay quiet. */
export const silentLogger: Logger = createLogger({ level: 'silent' });

function consoleSink(prefix: string): (record: LogRecord) => void {
  return ({ level, msg, data }) => {
    const line = `[${prefix}] ${msg}`;
    // Everything goes to stderr, including info. The CLI wrapper's stdout belongs
    // to the wrapped dev server; polluting it would corrupt output for anyone
    // piping the child's stdout into another tool.
    const suffix = data === undefined ? '' : ` ${safeJson(data)}`;
    if (level === 'error') {
      console.error(line + suffix);
      return;
    }
    if (level === 'warn') {
      console.warn(line + suffix);
      return;
    }
    console.error(line + suffix);
  };
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return '[unserialisable]';
  }
}
