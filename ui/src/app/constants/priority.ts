/**
 * Semantic color mappings for badges and indicators.
 *
 * All badge maps resolve to Spartan `hlmBadge` variants (semantic theme tokens),
 * so styling automatically follows light/dark themes. Dot indicators use
 * semantic tokens with opacity gradation.
 */

import { TASK_PRIORITY_CONFIG, type TaskPriorityLevel } from '@task-board/shared';

/** Subset of `hlmBadge` variants used across the app. */
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

/**
 * Priority-level → badge variant, keyed by the numeric level from
 * TASK_PRIORITY_CONFIG (0 = lowest … 3 = critical; extends with the config).
 */
export const PriorityVariantMap: Record<TaskPriorityLevel, BadgeVariant> = {
  0: 'outline',
  1: 'secondary',
  2: 'default',
  3: 'destructive',
};

/**
 * Selector options derived from TASK_PRIORITY_CONFIG — every priority
 * dropdown in the app renders from this one array.
 */
export const PRIORITY_OPTIONS: readonly { value: TaskPriorityLevel; labelKey: string }[] = TASK_PRIORITY_CONFIG.map(
  (c) => ({ value: c.level, labelKey: c.i18nKey }),
);

/**
 * URL query param (`?priorityLevel=`) → level. The raw value is always a
 * string; anything absent/invalid resolves to null (no filter).
 */
export function priorityLevelParam(value: unknown): TaskPriorityLevel | null {
  const n = Number(value);

  return TASK_PRIORITY_CONFIG.some((c) => c.level === n) ? (n as TaskPriorityLevel) : null;
}

/** Sprint status levels mapped to badge variants. */
export const StatusVariantMap = {
  FUTURE: 'secondary',
  ACTIVE: 'default',
  COMPLETED: 'outline',
} as const;

/** Tenant role levels mapped to badge variants. */
export const TenantRoleVariantMap = {
  OWNER: 'default',
  ADMIN: 'secondary',
  MEMBER: 'outline',
} as const;

/** Member status levels mapped to badge variants. */
export const MemberStatusVariantMap = {
  ACTIVE: 'default',
  PENDING: 'secondary',
  DECLINED: 'destructive',
  ACCESS_REVOKED: 'destructive',
} as const;

/** Priority dot indicator colors for sprint views (semantic tokens, ascending severity). */
export const PriorityDotColorMap: Record<TaskPriorityLevel, string> = {
  0: 'bg-primary/40',
  1: 'bg-primary/70',
  2: 'bg-destructive/70',
  3: 'bg-destructive',
};

/** Tenant status mapped to badge variants. */
export const TenantStatusVariantMap = {
  ACTIVE: 'default',
  ARCHIVED: 'secondary',
  DELETION_PENDING: 'destructive',
} as const;

// `ProjectStatusVariantMap` was removed as dead code — a byte-for-byte copy
// of `TenantStatusVariantMap` with no consumer, i.e. two names for one mapping.

/** Semantic hlm-badge variants keyed by task-type key (task/bug/story). Custom types fall back to outline. */
export const TaskTypeVariantMap = {
  TASK: 'default',
  BUG: 'destructive',
  STORY: 'secondary',
} as const;

export type TaskTypeVariant = (typeof TaskTypeVariantMap)[keyof typeof TaskTypeVariantMap] | 'outline';

/** Neutral fallback variant for unknown values */
export const NeutralVariant: BadgeVariant = 'outline';

/** Neutral fallback color for dot indicators */
export const NeutralDotColor = 'bg-muted-foreground';

/**
 * Badge variant lookup shared by sprint, tenant, and project statuses.
 * Sprint (FUTURE/ACTIVE/COMPLETED) and tenant/project (ACTIVE/ARCHIVED/DELETION_PENDING)
 * values are merged — overlapping keys agree on the same variant.
 */
const StatusBadgeVariantMap: Record<string, BadgeVariant> = { ...StatusVariantMap, ...TenantStatusVariantMap };

/** Resolve the badge variant for a task priority level. */
export function priorityBadgeVariant(priorityLevel: TaskPriorityLevel): BadgeVariant {
  return PriorityVariantMap[priorityLevel] ?? NeutralVariant;
}

/**
 * Resolve the i18n key for a priority level's display label (from
 * TASK_PRIORITY_CONFIG). The key resolves to the `priority.*` section in
 * `assets/i18n/*.json`. Returns '' for unknown levels so callers can fall back.
 */
export function priorityLabelKey(priorityLevel: TaskPriorityLevel): string {
  return TASK_PRIORITY_CONFIG.find((c) => c.level === priorityLevel)?.i18nKey ?? '';
}

/** Resolve the badge variant for a sprint/tenant/project status. Unknown values fall back to {@link NeutralVariant}. */
export function statusBadgeVariant(status: string): BadgeVariant {
  return StatusBadgeVariantMap[status] ?? NeutralVariant;
}

/** Resolve the badge variant for a tenant role. Unknown values fall back to {@link NeutralVariant}. */
export function roleBadgeVariant(role: string): BadgeVariant {
  return (TenantRoleVariantMap as Record<string, BadgeVariant>)[role] ?? NeutralVariant;
}

/** Resolve the badge variant for a tenant member status. Unknown values fall back to {@link NeutralVariant}. */
export function memberStatusBadgeVariant(status: string): BadgeVariant {
  return (MemberStatusVariantMap as Record<string, BadgeVariant>)[status] ?? NeutralVariant;
}

/** Resolve the semantic badge variant for a task type by its key (task/bug/story). Unknown keys fall back to `'outline'`. */
export function taskTypeBadgeVariant(key: string | null | undefined): TaskTypeVariant {
  if (!key) return 'outline';

  return (TaskTypeVariantMap as Record<string, TaskTypeVariant>)[key.toUpperCase()] ?? 'outline';
}
