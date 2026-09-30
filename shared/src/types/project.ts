import type { ProjectRole, ProjectStatus, ArchiveReason } from '../constants/roles.js';

/** Project entity type */
export interface Project {
  /** Unique project identifier (UUID v4) */
  id: string;
  /** Owning tenant ID */
  tenantId: string;
  /** Short unique project key (e.g., "PROJ") */
  key: string;
  /** Project name */
  name: string;
  /** Optional project description */
  description: string | null;
  /** Project lifecycle status */
  status: ProjectStatus;
  /** Default status ID assigned to new tasks */
  defaultStatusId: string;
  /** Reason for archival (null if not archived) */
  archiveReason: ArchiveReason | null;
  /** Scheduled deletion timestamp (ISO 8601, null if not scheduled) */
  deletionScheduledAt: string | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/**
 * Create project request body type.
 *
 * Every field carries an explicit `| undefined` because these interfaces model
 * the OUTPUT of a Zod schema (`z.string().optional()` parses to `string | undefined`
 * with the key possibly absent), and `exactOptionalPropertyTypes` forbids assigning
 * that to a bare `field?: T`. Writing `| undefined` documents "absent OR explicitly
 * undefined" instead of hiding it behind a cast.
 */
export interface CreateProject {
  key: string;
  name: string;
  description?: string | undefined;
}

/** Update project request body type — see {@link CreateProject} for the `| undefined` rule */
export interface UpdateProject {
  name?: string | undefined;
  description?: string | undefined;
}

/** Project membership type */
export interface ProjectMember {
  /** Unique member identifier (UUID v4) */
  id: string;
  /** Project ID */
  projectId: string;
  /** User ID of the member */
  userId: string;
  /** Role of the user within the project */
  role: ProjectRole;
  /** Display name of the user (resolved from users collection) */
  displayName?: string | undefined;
  /** Email of the user (resolved from users collection) */
  email?: string | undefined;
  /** Avatar URL of the user (resolved from users collection) */
  avatarUrl?: string | null | undefined;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}
