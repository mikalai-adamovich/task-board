// @task-board/shared
// Single source of truth for types and constants.
// Runtime-library free — no imports from Zod, Angular, Hono, RxJS, etc.

// ─── Utilities ───────────────────────────────────────────────────────────────
export { valuesOf } from './utils/values-of.js';
export {
  encodeBoardCursor,
  decodeBoardCursor,
  InvalidBoardCursorError,
  type BoardPageCursor,
} from './utils/board-cursor.js';
export { TENANT_SLUG_MAX_LENGTH, TENANT_SLUG_PATTERN, generateSlugFromName, isValidTenantSlug } from './utils/slug.js';

// ─── Constants ───────────────────────────────────────────────────────────────
export {
  TenantRole,
  TenantRoleValues,
  ProjectRole,
  ProjectRoleValues,
  SprintStatus,
  SprintStatusValues,
  MemberStatus,
  MemberStatusValues,
  InvitationStatus,
  InvitationStatusValues,
  TaskRelationshipType,
  TaskRelationshipTypeValues,
  TenantStatus,
  TenantStatusValues,
  ProjectStatus,
  ProjectStatusValues,
  ArchiveReason,
  ArchiveReasonValues,
  AuditAction,
  AuditActionValues,
  AuditEntityType,
  AuditEntityTypeValues,
} from './constants/roles.js';
export {
  TASK_PRIORITY_CONFIG,
  TASK_PRIORITY_LEVELS,
  DEFAULT_TASK_PRIORITY_LEVEL,
  type TaskPriorityLevel,
} from './constants/priority.js';
export { BOARD_PAGE_SIZE } from './constants/board.js';
export { TASK_SEARCH_MIN_LENGTH, TASK_SEARCH_MAX_LENGTH } from './constants/task-search.js';
// Bounds the server enforces and the client mirrors, in one place.
export { TENANT_NAME_MAX_LENGTH, TENANT_DESCRIPTION_MAX_LENGTH } from './constants/tenant-bounds.js';
export { ExpandState } from './constants/expand-state.js';
export {
  TASK_TABLE_COLUMN_KEYS,
  TASK_TABLE_PINNED_COLUMNS,
  DEFAULT_TASK_TABLE_COLUMNS,
} from './constants/task-table.js';
export type { TaskTableColumnKey } from './constants/task-table.js';
export {
  DATE_FORMAT_PREFERENCES,
  DATE_FORMAT_MAX_LENGTH,
  TIME_FORMAT_PREFERENCES,
  isValidDateFormat,
} from './constants/date-format.js';
export type { DateFormatPreference, TimeFormatPreference } from './constants/date-format.js';
export { HttpMethod, HttpMethodValues } from './constants/http.js';
export {
  JWT_TTL_SECONDS,
  PASSWORD_RESET_TTL_MINUTES,
  INVITATION_TTL_MS,
  DELETION_GRACE_PERIOD_MS,
} from './constants/time.js';
export { API_BASE_PATH, ApiPaths } from './constants/paths.js';
export { DEFAULT_THEME_ID } from './constants/theme.js';

// ─── Types ───────────────────────────────────────────────────────────────────
export type { User, CreateUser } from './types/user.js';

export type {
  LoginRequest,
  RegisterRequest,
  AuthResponse,
  AuthBootstrap,
  TenantWithRole,
  AcceptInvitation,
  InvitationDetails,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  ForgotPasswordResponse,
} from './types/auth.js';

export type {
  IdentitySnapshot,
  Tenant,
  CreateTenant,
  UpdateTenant,
  Invitation,
  TenantMember,
  MyInvitation,
} from './types/tenant.js';

export type { Project, CreateProject, UpdateProject, ProjectMember } from './types/project.js';

export type { BoardConfig, BoardColumn, UpdateBoardColumns, BoardColumnPage, BoardPage } from './types/board.js';

export type {
  Task,
  BoardTask,
  CreateTask,
  UpdateTask,
  BulkUpdateTasks,
  BulkUpdateTaskFailure,
  BulkUpdateTasksResult,
} from './types/task.js';

export type { Sprint, CreateSprint, UpdateSprint } from './types/sprint.js';

export type { Status, CreateStatus, UpdateStatus } from './types/status.js';

export type { TaskType, CreateTaskType, UpdateTaskType } from './types/task-type.js';

export type { Label, CreateLabel, UpdateLabel } from './types/label.js';

export type { Comment, CreateComment, UpdateComment } from './types/comment.js';

export type { TaskRelationship, CreateTaskRelationship } from './types/task-relationship.js';

export type { Filter, FilterCriteria, FilterSort, CreateFilter, UpdateFilter } from './types/filter.js';
// Shared sort-direction contract — `SortDirection` for TS positions,
// `SortDirectionValues` for `z.enum(...)` in the server schemas.
export { SortDirection, SortDirectionValues } from './types/filter.js';

export type { AuditEvent, AuditActor, AuditChange } from './types/audit.js';

export type { UserProjectBoardPreference, UpdateUserProjectBoardPreference } from './types/user-preference.js';

export type {
  ThemeManifestItem,
  ThemeMode,
  UserPreferences,
  UpdateUserPreferences,
  PaginatedResponse,
  PaginationParams,
  ErrorCode,
  ErrorResponse,
  SupportRequest,
} from './types/common.js';
// The error-code list is a runtime value so the client can DERIVE its
// message map from it (`Record<ErrorCode, string>` is exhaustive by type).
export { ERROR_CODES } from './types/common.js';
