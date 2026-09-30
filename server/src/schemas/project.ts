import * as z from 'zod';
import { ProjectRoleValues, ProjectStatusValues } from '@task-board/shared';
import { uuid, nonEmptyString, optionalString, nullableOptionalString, isoDateTime } from '../validators/common.js';

/**
 * Project key validation: 2-10 chars, starts with letter, uppercase + digits only.
 */
const projectKey = () =>
  z
    .string()
    .min(2, 'Key must be at least 2 characters')
    .max(10, 'Key must be at most 10 characters')
    .regex(/^[A-Z][A-Z0-9]*$/, 'Key must start with a letter and contain only uppercase letters and digits');

/**
 * Project entity schema.
 */
export const ProjectSchema = z.object({
  id: uuid(),
  tenantId: uuid(),
  key: projectKey(),
  name: nonEmptyString(200, 'Project name'),
  description: nullableOptionalString(120),
  status: z.enum(ProjectStatusValues),
  defaultStatusId: z.string(),
  archiveReason: z.string().nullable(),
  deletionScheduledAt: z.iso.datetime().nullable(),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
});

/**
 * Schema for creating a new project.
 */
export const CreateProjectSchema = z.object({
  key: projectKey(),
  name: nonEmptyString(200, 'Project name'),
  description: optionalString(120),
});

/**
 * Schema for updating an existing project.
 * Key cannot be changed after creation.
 */
export const UpdateProjectSchema = z.object({
  name: nonEmptyString(200, 'Project name').optional(),
  description: optionalString(120),
});

/**
 * Schema for adding a project member.
 */
export const AddProjectMemberSchema = z.object({
  userId: uuid(),
  role: z.enum(ProjectRoleValues),
});

/**
 * Schema for updating a project member's role.
 */
export const UpdateProjectMemberSchema = z.object({
  role: z.enum(ProjectRoleValues),
});

// `ProjectMemberSchema` was removed as dead code (unwired response schema —
// it validated nothing; the membership contract is the shared `ProjectMember`
// interface). `ProjectSchema` next to it is KEPT: `project.test.ts` exercises
// its 120-char description bound, so it is not dead.
