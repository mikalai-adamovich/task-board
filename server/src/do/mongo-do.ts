import { DurableObject } from 'cloudflare:workers';
import { app } from '../app.js';
import { assertRequiredConfiguration } from '../config/runtime-config.js';
import type { AppEnv } from '../types/context.js';

/**
 * Durable Object holding the Hono application and the persistent MongoClient.
 *
 * Why a DO: workerd binds TCP sockets to the request context that created
 * them, so a MongoClient cached in a plain Worker isolate dies with the
 * request that created it (workerd#2721 — our production experiment
 * reproduced hang + error 1101). A DO owns its own I/O context that
 * outlives individual requests, so a client created here (and its
 * connection pool) survives across requests for the DO's lifetime.
 *
 * The DO owns:
 * - the Hono app (same instance shape as the direct path — full API contract)
 * - the MongoClient + pool (created once per DO lifetime, never closed per
 *   request; `maxPoolSize: 5`, `maxIdleTimeMS: 30s` — see db/mongo.ts)
 *
 * Mongo migrations deliberately do NOT run here — they stay in
 * server/scripts/migrate.ts executed by CD before the deploy.
 *
 * The required-configuration boot gate runs HERE as well as in the Worker
 * entrypoint. The DO is a separate isolate with its own fetch entry, so a gate
 * that lived only in the Worker would let an unconfigured DO build a service
 * graph and sign nothing. Cheap (two presence checks) and it makes the
 * invariant hold on both paths into the application.
 */
export class MongoHonoDurableObject extends DurableObject<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    assertRequiredConfiguration(this.env as unknown as Record<string, unknown>);

    // Pass the DO's env (secrets + vars are shared with the Worker) and a
    // Hono-compatible execution context. DurableObjectState provides
    // waitUntil, which is all Hono's context uses.
    return app.fetch(request, this.env, this.ctx as unknown as ExecutionContext);
  }
}
