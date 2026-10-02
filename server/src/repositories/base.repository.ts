import type { Collection, Filter } from 'mongodb';
import { MAX_BULK_ID_LOOKUP } from '../db/read-bounds.js';

/**
 * Shared CRUD plumbing for repositories backed by an `id`-keyed collection.
 *
 * Concrete repositories extend this class and only implement {@link toDomain}
 * plus their specialized queries — `findById` / `delete` come for free.
 */
export abstract class BaseRepository<TDoc extends { id: string }, TDomain> {
  constructor(protected readonly collection: Collection<TDoc>) {}

  protected abstract toDomain(doc: TDoc): TDomain;

  async findById(id: string): Promise<TDomain | null> {
    // Filter/WithId variance workaround for generic document types
    const doc = (await this.collection.findOne({ id } as Filter<TDoc>)) as TDoc | null;

    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Bulk lookup by ids — single `$in` query. Used by batch enrichment paths
   * (e.g. audit-log label resolution) to avoid N+1 per-event lookups.
   *
   * REACHABLE, so the read is bounded. Every current caller hands it a
   * page-scoped id set (one audit page, one board's column set, one task's
   * refs), which makes {@link MAX_BULK_ID_LOOKUP} a backstop rather than a
   * working limit: it turns a future caller that forgets to scope its id list
   * into a truncated read instead of an unbounded one. Note that the result is
   * used for ENRICHMENT — a missing row renders an unresolved label — so a
   * truncation degrades output rather than corrupting it, which is the right
   * failure direction for a bound chosen this way.
   */
  async findByIds(ids: string[]): Promise<TDomain[]> {
    if (ids.length === 0) return [];

    const docs = (await this.collection
      .find({ id: { $in: ids } } as Filter<TDoc>)
      .limit(MAX_BULK_ID_LOOKUP)
      .toArray()) as TDoc[];

    return docs.map((doc) => this.toDomain(doc));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ id } as Filter<TDoc>);

    return result.deletedCount > 0;
  }
}
