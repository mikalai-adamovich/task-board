/**
 * Hono environment type defining Bindings (environment variables)
 * and Variables (request-scoped context) for the Task Board API v5.
 */

import type { User, TenantRole, ProjectRole } from '@task-board/shared';
import type { Services } from '../container.js';
import type { MongoHonoDurableObject } from '../do/mongo-do.js';

/** Hono environment type for the Task Board API */
export interface AppEnv {
  Bindings: {
    MONGODB_URI: string;
    JWT_SECRET: string;
    ALLOWED_ORIGINS?: string;
    /** Deployment environment — 'production' enables strict boot-time checks */
    ENVIRONMENT?: string;
    /** Minimum log level for the structured logger: debug | info | warn | error */
    LOG_LEVEL?: string;
    RESEND_API_KEY?: string;
    FRONTEND_URL?: string;
    /** Mongo client lifecycle: 'per-request' (production) | 'durable' (DO) | 'singleton' (broken experiment) */
    DB_CLIENT_MODE?: string;
    /**
     * The operator-declared instance count that keeps the login
     * limiter's DEPLOYMENT-wide ceiling constant when `DB_CLIENT_MODE` runs
     * more than one instance. Ignored in `durable` (one DO identity). A
     * positive integer or unset; anything else is treated as undeclared and
     * falls back to the conservative default in `utils/rate-limit-scope.ts`.
     */
    RATE_LIMIT_INSTANCE_BUDGET?: string;
    /** Durable Object holding the Hono app + persistent MongoClient (DB_CLIENT_MODE=durable) */
    MONGO_DO: DurableObjectNamespace<MongoHonoDurableObject>;
  };
  Variables: {
    /** Correlation id for this request (set by requestIdMiddleware) */
    requestId: string;
    /** TEMPORARY perf: user lookup started by auth middleware, resolved by resolveUser */
    userPromise?: Promise<User | null>;
    /** TEMPORARY perf: membership document pre-resolved in parallel by auth middleware */
    tenantMembershipDoc?: import('../repositories/tenant-member.repository.js').TenantMemberDocument;
    /** Membership resolved by tenantContextMiddleware — reused by services (no repeat query) */
    tenantMembership?: import('@task-board/shared').TenantMember;
    /** Authenticated user's ID (from JWT `sub` claim) */
    userId: string;
    /** Full authenticated user object */
    user: User;
    /** Active tenant ID (set by tenantContextMiddleware) */
    tenantId: string;
    /** User's role within the active tenant */
    tenantRole: TenantRole;
    /** User's role within the active project (set per-route when applicable) */
    projectRole?: ProjectRole;
    /** Request-scoped service graph (set by provideServices middleware) */
    svc: Services;
  };
}
