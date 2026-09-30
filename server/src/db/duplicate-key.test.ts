/**
 * `E11000` detection and the service-layer conflict mapping.
 *
 * The point of these tests is that ONLY a unique-index violation is
 * translated: every other driver failure must keep flowing to the mappings
 * that already exist for it (`QUERY_TIMEOUT` → 503, unknown → 500), because a
 * duplicate key is a client mistake and an exhausted pool is not.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DUPLICATE_KEY_CODE,
  isDuplicateKeyError,
  isTaskNumberConflict,
  withConflictOnDuplicate,
} from './duplicate-key.js';
import { ConflictError } from '../errors/app-error.js';
import { isQueryTimeoutError } from './query-timeout.js';

/** What the driver actually throws: an Error carrying `code` + `codeName`. */
function duplicateKeyError(indexName = 'projectId_1_sourceTaskId_1_targetTaskId_1') {
  return Object.assign(new Error(`E11000 duplicate key error collection: task_relationships index: ${indexName}`), {
    code: DUPLICATE_KEY_CODE,
    codeName: 'DuplicateKey',
    keyPattern: { projectId: 1, sourceTaskId: 1, targetTaskId: 1 },
  });
}

describe('isDuplicateKeyError', () => {
  it('recognises the driver error by code and by codeName', () => {
    expect(isDuplicateKeyError(duplicateKeyError())).toBe(true);
    expect(isDuplicateKeyError({ codeName: 'DuplicateKey' })).toBe(true);
  });

  it('does not swallow any other failure', () => {
    expect(isDuplicateKeyError({ code: 50, codeName: 'MaxTimeMSExpired' })).toBe(false);
    expect(isDuplicateKeyError({ code: 89, codeName: 'NetworkTimeout' })).toBe(false);
    expect(isDuplicateKeyError({ code: 11001, codeName: 'LegacyDuplicateKey' })).toBe(false);
    expect(isDuplicateKeyError(new Error('plain'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError('E11000')).toBe(false);
  });

  it('cannot be confused with a maxTimeMS expiry (F11 mapping stays intact)', () => {
    expect(isQueryTimeoutError(duplicateKeyError())).toBe(false);
  });
});

describe('withConflictOnDuplicate', () => {
  it('returns the insert result when nothing conflicts', async () => {
    const operation = vi.fn().mockResolvedValue({ id: 'rel-1' });

    await expect(withConflictOnDuplicate(operation, () => new ConflictError('dup'))).resolves.toEqual({ id: 'rel-1' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('maps a lost race to the supplied domain conflict', async () => {
    const conflict = () => new ConflictError('A relationship between these tasks already exists', 'CONFLICT');

    await expect(withConflictOnDuplicate(() => Promise.reject(duplicateKeyError()), conflict)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A relationship between these tasks already exists',
    });
  });

  it('never lets driver detail reach the client message', async () => {
    const err = await withConflictOnDuplicate(
      () => Promise.reject(duplicateKeyError('userId_1')),
      () => new ConflictError('A user with this email already exists'),
    ).catch((e: Error) => e);

    expect(err.message).toBe('A user with this email already exists');
    expect(err.message).not.toContain('E11000');
    expect(err.message).not.toContain('index');
    expect(err.message).not.toContain('collection');
  });

  it('re-throws every non-duplicate driver error untouched', async () => {
    const timeout = { code: 50, codeName: 'MaxTimeMSExpired', message: 'operation exceeded time limit' };
    const conflict = vi.fn(() => new ConflictError('never used'));

    await expect(withConflictOnDuplicate(() => Promise.reject(timeout), conflict)).rejects.toBe(timeout);
    await expect(withConflictOnDuplicate(() => Promise.reject(new Error('socket hang up')), conflict)).rejects.toThrow(
      'socket hang up',
    );
    expect(conflict).not.toHaveBeenCalled();
  });

  it('does not retry — a conflict is reported, never silently re-issued', async () => {
    const operation = vi.fn().mockRejectedValue(duplicateKeyError());

    await expect(withConflictOnDuplicate(operation, () => new ConflictError('dup'))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

/**
 * The ONE index whose `E11000` is a race to retry rather than a conflict
 * to report. The whole safety argument of the retry loop lives in this
 * predicate, so the negative cases are the interesting ones: anything it cannot
 * positively identify as the numbering index must be left alone.
 */
describe('isTaskNumberConflict', () => {
  const numbering = () =>
    Object.assign(new Error('E11000 duplicate key error collection: tasks index: projectId_1_number_-1'), {
      code: DUPLICATE_KEY_CODE,
      codeName: 'DuplicateKey',
      keyPattern: { projectId: 1, number: -1 },
    });

  it('recognises the numbering index the driver actually reports', () => {
    expect(isTaskNumberConflict(numbering())).toBe(true);
  });

  it('rejects every OTHER unique index', () => {
    for (const keyPattern of [
      { id: 1 },
      { projectId: 1, userId: 1 },
      { projectId: 1, key: 1 },
      { email: 1 },
      // A superset/subset must not pass as "the numbering index" either.
      { projectId: 1, number: -1, statusId: 1 },
      { projectId: 1 },
      { number: -1 },
    ]) {
      expect(isTaskNumberConflict({ code: DUPLICATE_KEY_CODE, keyPattern })).toBe(false);
    }
  });

  it('rejects a violation whose index cannot be identified', () => {
    // No keyPattern at all: retrying blind would mask a real duplicate.
    expect(isTaskNumberConflict({ code: DUPLICATE_KEY_CODE, codeName: 'DuplicateKey' })).toBe(false);
    expect(isTaskNumberConflict(new Error('E11000 duplicate key error collection: tasks'))).toBe(false);
  });

  it('rejects the same keyPattern on a key of a DIFFERENT direction', () => {
    // {projectId, number} with `number: 1` is not the index that is deployed;
    // answering `true` here would mean matching on a guess.
    expect(isTaskNumberConflict({ code: DUPLICATE_KEY_CODE, keyPattern: { projectId: 1, number: 1 } })).toBe(false);
  });

  it('never mistakes a non-duplicate failure for a numbering race', () => {
    expect(
      isTaskNumberConflict({ code: 50, codeName: 'MaxTimeMSExpired', keyPattern: { projectId: 1, number: -1 } }),
    ).toBe(false);
    expect(isTaskNumberConflict(null)).toBe(false);
  });
});
