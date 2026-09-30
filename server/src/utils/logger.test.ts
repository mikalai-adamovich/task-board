import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

type LogEntry = Record<string, unknown>;

describe('logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // The parameter is typed as "has a `mock.lastCall`" rather than an exact
  // structural type — Vitest's `MockInstance.mock.lastCall` is non-optional, so
  // an exact match is not assignable under `exactOptionalPropertyTypes`.
  function lastEntry(spy: { mock: { lastCall: unknown[] | undefined } }): LogEntry {
    const line = spy.mock.lastCall?.[0];

    expect(typeof line).toBe('string');

    return JSON.parse(line as string) as LogEntry;
  }

  it('writes a single-line JSON object with ts, level and msg', () => {
    createLogger().info('hello');

    expect(logSpy).toHaveBeenCalledTimes(1);

    const entry = lastEntry(logSpy);

    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('hello');
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
  });

  it('merges child bindings and per-call meta into the line', () => {
    const log = createLogger({ scope: 'migrations' }).child({ requestId: 'r-1' });

    log.warn('backfilled', { count: 3 });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    const entry = lastEntry(warnSpy);

    expect(entry).toMatchObject({ scope: 'migrations', requestId: 'r-1', count: 3, level: 'warn' });
  });

  it('serializes Error values in meta to name + message', () => {
    createLogger().error('failed', { err: new Error('boom') });

    const entry = lastEntry(errorSpy);

    expect(entry.err).toEqual({ name: 'Error', message: 'boom' });
  });

  it('routes warn to console.warn and error to console.error', () => {
    const log = createLogger();

    log.warn('w');
    log.error('e');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses debug at the default level (info)', () => {
    createLogger().debug('noisy');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits debug when LOG_LEVEL=debug', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');

    createLogger().debug('verbose');

    expect(logSpy).toHaveBeenCalledTimes(1);

    const entry = lastEntry(logSpy);

    expect(entry.level).toBe('debug');
  });

  it('suppresses info when LOG_LEVEL=error but still emits error', () => {
    vi.stubEnv('LOG_LEVEL', 'error');

    const log = createLogger();

    log.info('quiet');
    log.error('loud');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
