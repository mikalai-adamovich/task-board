/**
 * Worker entrypoint — a thin routing/proxy layer, behind a boot gate.
 *
 * - `DB_CLIENT_MODE=per-request` (production default): the Hono app runs
 *   directly in the Worker with a fresh MongoClient per request (the proven
 *   rollback path).
 * - `DB_CLIENT_MODE=durable`: everything except the no-DB liveness endpoints
 *   is proxied into {@link MongoHonoDurableObject}, which owns the Hono app
 *   and a persistent MongoClient + pool. The Request/Response pair is
 *   forwarded untouched — method, URL, headers, body and streaming are
 *   preserved, so the API contract is identical for clients.
 *
 * `/api/ping` and `/api/health` always stay on the Worker: true liveness must
 * not depend on the DO (or MongoDB) being up. `/api/readyz` is proxied — it
 * verifies a fresh MongoDB connection by design.
 *
 * ── REQUIRED CONFIGURATION (decision (a)) ──────────────────────────────────────
 * A Cloudflare Worker has no boot phase of its own: the closest equivalent to
 * "start-up" is the first line of `fetch`, so the required set
 * (`MONGODB_URI`, `JWT_SECRET` — see `config/runtime-config.ts`) is asserted
 * HERE, before any routing, on every invocation.
 *
 * The gate is NOT exempted for the liveness endpoints, and that is deliberate:
 * a Worker with no signing secret is not alive in any useful sense, and
 * exempting `/api/health` would recreate exactly the failure the decision
 * closed — a deployment that is green on every signal the system exposes and
 * still cannot sign a token. A misconfigured deploy now fails loudly, on the
 * first request, with the missing variable NAMES in the message; it does not
 * serve. `assertRequiredConfiguration` never reads a value, only its presence.
 * ── SCHEDULED PURGE ───────────────────────────────────────────────────────────────
 * A two-phase delete that nothing ever executes is a promise the product cannot
 * keep: a project or a workspace moves to `DELETION_PENDING` with a 30-day grace
 * deadline and then simply stays there. This `scheduled` entrypoint is the actor.
 *
 * WHY A SCHEDULED HANDLER AND NOT A TIME-TO-LIVE INDEX. Both are available on
 * this platform and the decision was to build one. A TTL index deletes a document
 * when a date ON THAT DOCUMENT passes; the purge has to delete documents in nine
 * other collections in a defined order, report what it removed, and leave the
 * root document in place when a step fails so the next run can retry. TTL can do
 * none of that, and a TTL index on `deletionScheduledAt` would also delete the
 * row that records a FAILED purge, converting a recoverable state into a silent
 * one. The TTL index this package DOES build is for the audit retention window
 * where deleting the row on a clock is exactly the requirement.
 *
 * The trigger is a platform CRON TRIGGER declared in `server/wrangler.toml`
 * (`[triggers] crons`), which the platform invokes on this method. It is
 * configured OUTSIDE this file on purpose: the schedule is a deployment fact, not
 * a code fact, and the deploy that carries it is the CD workflow's.
 *
 * Concurrency: two overlapping invocations are safe. Every purge step is a
 * `deleteMany`- or `deleteOne`-shaped operation and each entity is re-read before
 * it is touched, so the second run finds either nothing or an entity already gone
 * (`already-gone`) and does no work. Nothing here takes a lock, because a lock
 * would add a failure mode (a stale lock blocking every future purge) to buy
 * nothing.
 *
 * The configuration gate runs here too, for the same reason it runs in `fetch`:
 * a purge that ran against a misconfigured deployment would delete data on the
 * strength of a half-configured Worker. It throws before a single delete.
 */

import { app, shouldProxyToDurable } from './app.js';
import { MongoHonoDurableObject } from './do/mongo-do.js';
import { assertRequiredConfiguration } from './config/runtime-config.js';
import { buildPurgeService } from './container.js';
import { getMongoClient, runWithDb } from './db/mongo.js';
import { createLogger } from './utils/logger.js';
import type { AppEnv } from './types/context.js';

const scheduledLog = createLogger({ scope: 'purge.scheduled' });

export { MongoHonoDurableObject };

export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    assertRequiredConfiguration(env as unknown as Record<string, unknown>);

    const { pathname } = new URL(request.url);

    if (shouldProxyToDurable(env.DB_CLIENT_MODE, pathname)) {
      // `idFromName` gives one stable DO identity — i.e. ONE instance.
      //
      // SECURITY PARAMETER, not only a performance one. The
      // per-user rate limiter's counters live in that instance's memory
      // (`utils/rate-limiter.ts`), so the credential-stuffing ceiling is
      // `AUTH_MAX_REQUESTS × instances`. Today instances = 1, which is why the
      // in-process limiter is an acceptable control at all. Changing the
      // identity below (e.g. to a cached per-user `idFromString`), or falling
      // back to `per-request` where each isolate gets its own counters,
      // MULTIPLIES that ceiling silently and with no failing test. The
      // per-get coordination cost is acceptable at current traffic; a cached
      // `idFromString` is not a performance refactor, it is a security change
      // and needs a mode-aware counter first (the audit's Q4 — not built).
      const id = env.MONGO_DO.idFromName('mongo');
      // `weur` (Western Europe) is a best-effort hint towards the MongoDB
      // Atlas region (eu-central-1) — only the FIRST get() honours it.
      const stub = env.MONGO_DO.get(id, { locationHint: 'weur' });
      const response = await stub.fetch(request);

      return response;
    }

    return app.fetch(request, env, ctx);
  },

  /**
   * The scheduled purge. Runs the once-a-day cascade over every project and
   * workspace whose 30-day grace deadline has passed.
   *
   * Its own connection, deliberately: a scheduled invocation is not a request and
   * does not pass through the request-scoped DB middleware in `app.ts`, so it
   * acquires a client and closes it here. The `per-request` mode is correct for
   * this and is the documented rollback path; `durable` mode's whole point is a
   * pool that survives across REQUESTS, and there is no request here to survive
   * for. A purge that reused the request pool would hold it open for the duration
   * of a batch job.
   *
   * Failures are LOGGED, never swallowed: the run reports per-entity outcomes and
   * a non-empty failure list is logged at error level, because a purge that
   * silently stops is indistinguishable from a purge that had nothing to do.
   */
  async scheduled(_controller: ScheduledController, env: AppEnv['Bindings']): Promise<void> {
    assertRequiredConfiguration(env as unknown as Record<string, unknown>);

    const uri = env.MONGODB_URI;

    if (!uri) {
      // Unreachable: `assertRequiredConfiguration` throws on a missing
      // `MONGODB_URI` before this line. Present anyway so the failure mode is a
      // log line naming the variable rather than a `connect(undefined)`.
      scheduledLog.error('Scheduled purge skipped: MONGODB_URI is not configured');

      return;
    }

    const client = await getMongoClient(uri, 'per-request');

    try {
      const report = await runWithDb(client.db(), () => buildPurgeService().runDue());

      if (report.failed.length > 0) {
        scheduledLog.error('Scheduled purge completed with failures — those entities stay scheduled and are retried', {
          failed: report.failed.length,
          ids: report.failed.map((failure) => `${failure.kind}:${failure.id}`),
        });
      }
    } catch (err) {
      // The connection, the graph or the selection query failed. Logged and
      // re-thrown: the platform records a failed scheduled invocation, which is
      // the only signal that the purge is not running at all.
      scheduledLog.error('Scheduled purge failed', { err: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      await client.close();
    }
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
