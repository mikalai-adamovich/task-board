/**
 * Minimal structured logger.
 *
 * Writes single-line JSON to `console` — one parseable object per line:
 * ```json
 * {"ts":"2026-01-01T00:00:00.000Z","level":"info","msg":"...","scope":"migrations"}
 * ```
 *
 * Level is gated by the `LOG_LEVEL` environment variable (`debug` | `info` |
 * `warn` | `error`; default `info`). The level is read lazily on every call so
 * tests and Workers isolates observe the current value without module-level
 * caching.
 *
 * This is the ONLY place in the server that should call `console.*` for
 * application logging. `hono/logger` (access logs, with the redacting wrapper
 * in `index.ts`) remains a separate, deliberate exception.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Static extra fields attached to every line of a logger instance. */
export type LogBindings = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: LogBindings): void;
  info(msg: string, meta?: LogBindings): void;
  warn(msg: string, meta?: LogBindings): void;
  error(msg: string, meta?: LogBindings): void;
  /** Derive a logger with additional static bindings (e.g. `{ scope: 'db' }`). */
  child(bindings: LogBindings): Logger;
}

function minLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;

  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/** Errors do not JSON-serialize usefully — flatten them to name + message. */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  return value;
}

/* eslint-disable no-console -- this module IS the logging sink; every other
   call site must go through the Logger interface. */
function write(level: LogLevel, msg: string, bindings: LogBindings, meta?: LogBindings): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel()]) {
    return;
  }

  const entry: LogBindings = { ts: new Date().toISOString(), level, msg, ...bindings };

  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      entry[key] = serializeValue(value);
    }
  }

  const line = JSON.stringify(entry);

  if (level === 'warn') {
    console.warn(line);
  } else if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
/* eslint-enable no-console */

export function createLogger(bindings: LogBindings = {}): Logger {
  return {
    debug: (msg, meta) => write('debug', msg, bindings, meta),
    info: (msg, meta) => write('info', msg, bindings, meta),
    warn: (msg, meta) => write('warn', msg, bindings, meta),
    error: (msg, meta) => write('error', msg, bindings, meta),
    child: (childBindings) => createLogger({ ...bindings, ...childBindings }),
  };
}

/** Root application logger. Prefer `createLogger({ scope: '...' })` per module. */
export const logger: Logger = createLogger();
