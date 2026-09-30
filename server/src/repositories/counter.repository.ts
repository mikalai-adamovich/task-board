import type { Collection } from 'mongodb';
import { escapeRegExp } from '../utils/regex.js';

// guardrail:no-base-repository 2026-09-29 — counters are keyed by the Mongo
// `_id` (a string such as `taskNumber:<projectId>`), not by an `id` field, and
// the only operation is an atomic `$inc` upsert. There is nothing for an
// `id`-keyed base to add. See `rules/guardrails.guardrail.test.ts` (P-03).

// ─── MongoDB Document Shape ───────────────────────────────────────────────────

export interface CounterDocument {
  _id: string; // e.g., "taskNumber:<projectId>"
  value: number;
}

// ─── Counter Repository ──────────────────────────────────────────────────────

/**
 * Atomic counter using MongoDB `$inc` with `upsert: true`.
 * Used for generating sequential task numbers within a project.
 */
export class CounterRepository {
  constructor(private readonly collection: Collection<CounterDocument>) {}

  /**
   * Atomically increments the counter and returns the new value.
   * First call for a key creates the document with value: 1.
   */
  async getNextValue(key: string): Promise<number> {
    const result = await this.collection.findOneAndUpdate(
      { _id: key },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );

    return result?.value ?? 1;
  }
  // `getCurrentValue(key)` was removed as dead code. `increment()` is the
  // only counter operation in the product; a read-without-increment accessor has
  // no caller and, if one appeared, it would be a TOCTOU read next to the
  // `findOneAndUpdate` that actually allocates the number.

  /**
   * Delete all counters belonging to a project. Used for cascade delete.
   *
   * Counter documents are keyed `_id: "taskNumber:<projectId>"` and carry no
   * `projectId` field — filtering on `{ projectId }` never matched anything,
   * so the cascade silently leaked counter documents. Filter on the key
   * prefix instead (escaped — projectId is a UUID but never trust it raw).
   */
  async deleteByProject(projectId: string): Promise<void> {
    await this.collection.deleteMany({ _id: { $regex: `^taskNumber:${escapeRegExp(projectId)}$` } });
  }
}
