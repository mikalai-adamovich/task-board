/** Status entity type (project-level workflow status) */
export interface Status {
  /** Unique status identifier (UUID v4) */
  id: string;
  /** Parent project ID */
  projectId: string;
  /** Display name of the status (e.g., "TODO", "IN_PROGRESS") */
  name: string;
  /** Normalized name for case-insensitive lookups */
  normalizedName: string;
  /** Position/order within the project's status list */
  position: number;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
}

/** Create status request body type */
export interface CreateStatus {
  name: string;
  position: number;
}

/** Update status request body type */
export interface UpdateStatus {
  name?: string | undefined;
  position?: number | undefined;
}
