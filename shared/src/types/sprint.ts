import type { SprintStatus } from '../constants/roles.js';

/** Sprint entity type */
export interface Sprint {
  /** Unique sprint identifier (UUID v4) */
  id: string;
  /** Parent project ID */
  projectId: string;
  /** Sprint name (e.g., "Sprint 1") */
  name: string;
  /** Sprint lifecycle status */
  status: SprintStatus;
  /** Sprint start date (ISO 8601 date, null if not set) */
  startDate: string | null;
  /** Sprint end date (ISO 8601 date, null if not set) */
  endDate: string | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Create sprint request body type */
export interface CreateSprint {
  name: string;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

/** Update sprint request body type */
export interface UpdateSprint {
  name?: string | undefined;
  /** `null` clears the date */
  startDate?: string | null | undefined;
  /** `null` clears the date */
  endDate?: string | null | undefined;
  status?: SprintStatus | undefined;
}
