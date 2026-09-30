import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types/context.js';
import { param, pathParamValidation, validateBody } from '../middleware/validation.js';
import { CreateFilterSchema, UpdateFilterSchema } from '../schemas/filter.js';
import type { CallerContext } from '../services/tenant-assert.js';

/**
 * The caller context is ALWAYS forwarded to the service layer. It comes
 * from the request context set by the auth / tenant-context middleware — never
 * from the path or the body — and the service treats it as required
 * (missing → 401, foreign tenant → 404).
 */
function callerContext(c: Context<AppEnv>): CallerContext {
  return { tenantId: c.get('tenantId'), userId: c.get('userId'), userRole: c.get('tenantRole') };
}

export function createFilterRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Every path parameter of every route below is parsed with Zod before its
  // handler runs (see middleware/validation.ts + validators/path-params.ts).
  router.use('*', pathParamValidation());

  // The project is tenant-asserted inside the service on EVERY path
  // (read, create, update, delete) — not only on the read one.

  router.get('/projects/:projectId/filters', async (c) => {
    const projectId = param(c, 'projectId');
    const filters = await c.get('svc').filters.getFiltersByUserAndProject(projectId, callerContext(c));

    return c.json({ data: filters });
  });

  router.post('/projects/:projectId/filters', validateBody(CreateFilterSchema), async (c) => {
    const projectId = param(c, 'projectId');
    const body = c.req.valid('json');
    const filter = await c.get('svc').filters.createFilter(projectId, body, callerContext(c));

    return c.json({ data: filter }, 201);
  });

  router.patch('/filters/:filterId', validateBody(UpdateFilterSchema), async (c) => {
    const filterId = param(c, 'filterId');
    const body = c.req.valid('json');
    const filter = await c.get('svc').filters.updateFilter(filterId, body, callerContext(c));

    return c.json({ data: filter });
  });

  router.delete('/filters/:filterId', async (c) => {
    const filterId = param(c, 'filterId');

    await c.get('svc').filters.deleteFilter(filterId, callerContext(c));

    return c.json({ data: { success: true } });
  });

  return router;
}
