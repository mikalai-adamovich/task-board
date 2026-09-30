/**
 * Audit log authorization.
 *
 * Two vectors are covered:
 * 1. `GET /tenants/:tenantId/audit` used to trust the PATH tenant, so any
 *    authenticated member of any tenant could read an arbitrary tenant's
 *    activity log (production proof: unrelated tenant MEMBER → 200).
 * 2. `view_audit_events` was defined in the RBAC matrix but enforced NOWHERE.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAuditRoutes } from './audit.js';
import { errorHandler } from '../middleware/error-handler.js';
import { NotFoundError, UnauthorizedError } from '../errors/app-error.js';
import type { AppEnv } from '../types/context.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../db/mongo.js', () => ({
  getCollection: vi.fn(() => ({ findOne: vi.fn() })),
}));

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const FOREIGN_TENANT_ID = '550e8400-e29b-41d4-a716-4466554400ff';
const USER_ID = '550e8400-e29b-41d4-a716-446655440002';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440010';
const emptyPage = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };

function createTestApp(tenantRole = 'OWNER', tenantId = TENANT_ID) {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);

  const projects = { getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, tenantId }) };
  const audit = {
    queryByProject: vi.fn().mockResolvedValue(emptyPage),
    queryByTenant: vi.fn().mockResolvedValue(emptyPage),
  };

  app.use('/api/*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('tenantId', tenantId);
    c.set('tenantRole', tenantRole as 'OWNER');
    c.set('svc', { projects, audit } as never);
    await next();
  });

  app.route('/api', createAuditRoutes());

  return { app, projects, audit };
}

// ─── GET /api/tenants/:tenantId/audit ────────────────────────────────────────

describe('GET /api/tenants/:tenantId/audit (M-004)', () => {
  it('returns 200 and queries the CONTEXT tenant (never the path one)', async () => {
    const { app, audit } = createTestApp('OWNER');
    const res = await app.request(`/api/tenants/${TENANT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(200);
    expect(audit.queryByTenant).toHaveBeenCalledWith(TENANT_ID, expect.objectContaining({ page: 1 }));
  });

  it('rejects a path :tenantId that is not the caller tenant with 404', async () => {
    const { app, audit } = createTestApp('OWNER');
    const res = await app.request(`/api/tenants/${FOREIGN_TENANT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(404);
    expect(audit.queryByTenant).not.toHaveBeenCalled();

    const body = (await res.json()) as { error: { code: string } };

    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('enforces view_audit_events: a plain tenant MEMBER is denied 403', async () => {
    const { app, audit } = createTestApp('MEMBER');
    const res = await app.request(`/api/tenants/${TENANT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(403);
    expect(audit.queryByTenant).not.toHaveBeenCalled();
  });
});

// ─── GET /api/projects/:projectId/audit ──────────────────────────────────────

describe('GET /api/projects/:projectId/audit (M-004)', () => {
  it('returns 200 and forwards the caller context to the project lookup', async () => {
    const { app, projects, audit } = createTestApp('OWNER');
    const res = await app.request(`/api/projects/${PROJECT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(200);
    expect(projects.getProject).toHaveBeenCalledWith(PROJECT_ID, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      userRole: 'OWNER',
    });
    expect(audit.queryByProject).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({ page: 1 }));
  });

  it('answers 404 for a project of another tenant and never queries the audit log', async () => {
    const { app, projects, audit } = createTestApp('OWNER');

    projects.getProject.mockRejectedValue(new NotFoundError('Project not found'));

    const res = await app.request(`/api/projects/${PROJECT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(404);
    expect(audit.queryByProject).not.toHaveBeenCalled();
  });

  it('answers 401 when the request reaches the service without a caller context', async () => {
    const { app, projects, audit } = createTestApp('OWNER');

    projects.getProject.mockRejectedValue(new UnauthorizedError('Caller context is required'));

    const res = await app.request(`/api/projects/${PROJECT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(401);
    expect(audit.queryByProject).not.toHaveBeenCalled();
  });

  it('enforces view_audit_events: a plain tenant MEMBER is denied 403', async () => {
    const { app, audit } = createTestApp('MEMBER');
    const res = await app.request(`/api/projects/${PROJECT_ID}/audit`, {}, { MONGODB_URI: '' });

    expect(res.status).toBe(403);
    expect(audit.queryByProject).not.toHaveBeenCalled();
  });
});
