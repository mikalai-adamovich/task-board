import { NotFoundError, UnauthorizedError } from '../errors/app-error.js';
import { assertProjectAcceptsWrites, type WriteGuardedProject } from './project-write-guard.js';

/**
 * Minimal project repository interface needed to resolve an entity's tenant.
 *
 * `status` is part of the shape because the WRITE seam needs it (a project
 * scheduled for deletion is read-only) and the tenant seam already performs the
 * lookup — widening the returned projection costs nothing and avoids a second
 * query on every write. It stays OPTIONAL so a repository double that models
 * only the tenant still satisfies the interface; the write predicate treats an
 * unreadable status as frozen rather than legal.
 */
export interface TenantAssertProjectRepo {
  findById(id: string): Promise<({ tenantId: string } & WriteGuardedProject) | null>;
}

/**
 * Caller context every project-scoped method must receive.
 *
 * The previous signatures took `userId?` / `userRole?`
 * and silently skipped the permission check when they were missing, which made
 * authorization fail OPEN whenever a call site forgot to forward the context
 * (production proof: `routes/labels.ts` → `createLabel(projectId, body)`).
 * The context is now a single REQUIRED object — omitting it is a compile error,
 * and an object with empty fields is rejected at runtime by
 * {@link requireCallerContext}.
 */
export interface CallerContext {
  /** Active tenant id — from the request context (`c.get('tenantId')`). */
  tenantId: string;
  /** Acting user id — from the request context (`c.get('userId')`). */
  userId: string;
  /** Acting tenant role — from the request context (`c.get('tenantRole')`). */
  userRole: string;
}

/**
 * Fail-closed counterpart of the old `if (!userId || !userRole) return;` guard.
 *
 * A caller that reaches a project-scoped service without an authenticated
 * context is a bug in the call chain, not a licence to skip authorization:
 * it now throws {@link UnauthorizedError} (401) instead of returning silently.
 */
export function requireCallerContext(context: CallerContext): CallerContext {
  if (!context || !context.tenantId || !context.userId || !context.userRole) {
    throw new UnauthorizedError('Caller context is required');
  }

  return context;
}

/**
 * The mandatory seam for every project-scoped method.
 *
 * Loads the project addressed by `projectId` and throws when it does not
 * belong to `tenantId`. On mismatch (or an unresolvable project) it throws
 * 404 — deliberately NOT 403 — so a foreign project id is indistinguishable
 * from a nonexistent one and the response does not leak the existence of a
 * cross-tenant resource.
 *
 * A missing project repository is treated as "cannot prove ownership" and
 * therefore also yields 404 (fail closed).
 *
 * @returns the resolved project (callers reuse it for audit logging instead of
 *          issuing a second lookup).
 */
export async function assertProjectInTenant(
  projectRepo: TenantAssertProjectRepo | undefined,
  projectId: string,
  tenantId: string,
  label = 'Project',
): Promise<{ tenantId: string } & WriteGuardedProject> {
  const project = projectRepo ? await projectRepo.findById(projectId) : null;

  if (!project || project.tenantId !== tenantId) {
    throw new NotFoundError(`${label} not found`);
  }

  return project;
}

/**
 * The WRITE seam: tenant scope first (404 on a foreign project,
 * never 403), then the single server-owned rule "does this project accept
 * writes?" ({@link assertProjectAcceptsWrites} in `project-write-guard.ts`).
 *
 * Every project-scoped write path in every service goes through THIS function,
 * which is what makes the rule one place rather than one copy per service. A
 * service that grows a new write method calls this and inherits the rule; a
 * service that calls the read-only {@link assertProjectInTenant} instead has
 * chosen, visibly, to serve a read.
 *
 * The order is deliberate and matches the rest of the seam: ownership is proven
 * BEFORE the state of the resource is discussed, so a foreign project is a 404
 * whatever its status and cannot be distinguished from a nonexistent one.
 */
export async function assertProjectWritableInTenant(
  projectRepo: TenantAssertProjectRepo | undefined,
  projectId: string,
  tenantId: string,
  label = 'Project',
): Promise<{ tenantId: string } & WriteGuardedProject> {
  const project = await assertProjectInTenant(projectRepo, projectId, tenantId, label);

  assertProjectAcceptsWrites(project, label);

  return project;
}

/**
 * Assert that an entity addressed by a bare id belongs to the caller's
 * tenant. Entities only carry `projectId`, so the tenant is resolved through
 * the owning project.
 *
 * On mismatch (or an unresolvable project) throws 404 — deliberately NOT 403 —
 * so the response does not leak the existence of a cross-tenant resource.
 */
export async function assertTenantEntity(
  projectRepo: TenantAssertProjectRepo | undefined,
  projectId: string,
  tenantId: string,
  label: string,
): Promise<void> {
  await assertProjectInTenant(projectRepo, projectId, tenantId, label);
}
