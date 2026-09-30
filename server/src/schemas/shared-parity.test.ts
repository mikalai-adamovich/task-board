import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AuditActionValues,
  AuditEntityTypeValues,
  InvitationStatusValues,
  MemberStatusValues,
  SprintStatusValues,
  SortDirectionValues,
  TASK_PRIORITY_LEVELS,
  TaskRelationshipTypeValues,
  TenantRoleValues,
  type AuditAction,
  type AuditEntityType,
  type MemberStatus,
  type SortDirection,
  type SprintStatus,
  type TaskPriorityLevel,
  type TaskRelationshipType,
  type TenantRole,
  type ThemeMode,
} from '@task-board/shared';
import { AuditQuerySchema } from './audit.js';
import { CreateFilterSchema } from './filter.js';
import { UpdateSprintSchema } from './sprint.js';
import { CreateTaskRelationshipSchema } from './task-relationship.js';
import { CreateTaskSchema } from './task.js';
import { InviteMemberSchema, MyInvitationSchema, UpdateMemberSchema } from './tenant.js';
import { UpdateUserGlobalSettingsSchema } from './user-preferences.js';
import { assertCorrespondence } from '../testing/correspondence.js';

// `import.meta.dirname` avoids the Workers-`URL` vs `node:url` `URL` clash
// that `fileURLToPath(new URL(...))` runs into under @cloudflare/workers-types.
const SERVER_SRC = join(dirname(import.meta.filename), '..');

/** Every non-spec TypeScript source under `server/src`. */
function serverSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return serverSources(path);
    // A spec may construct any value it likes; only production code can widen a
    // domain or narrow what the audit log actually records.
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

const PRODUCTION_SOURCE = serverSources(SERVER_SRC);
/** Every `action: '…'` the server actually writes to the audit log. */
const AUDIT_ACTIONS_WRITTEN = [
  ...new Set(
    PRODUCTION_SOURCE.flatMap((source) => [...source.matchAll(/\baction:\s*'([A-Z_]+)'/g)].map((m) => m[1] ?? '')),
  ),
].sort();
/** Every `entityType: '…'` the server actually writes to the audit log. */
const AUDIT_ENTITY_TYPES_WRITTEN = [
  ...new Set(
    PRODUCTION_SOURCE.flatMap((source) => [...source.matchAll(/\bentityType:\s*'([A-Z_]+)'/g)].map((m) => m[1] ?? '')),
  ),
].sort();
/**
 * Every tenant role a membership write path hard-codes (`role: TenantRole.X`).
 * The invitation/update schemas decide which roles a member may be GIVEN; this
 * is the set decided anywhere else in the server. The two must not disagree: a
 * service granting a role the schema refuses is a role the boundary cannot
 * validate, and a role nobody may grant (the tenant's owner, whose role is not
 * transferable) must never appear here.
 */
const ROLES_HARDCODED_IN_WRITES = [
  ...new Set(
    [
      ...readFileSync(join(SERVER_SRC, 'services', 'tenant-member.service.ts'), 'utf8').matchAll(
        /\brole:\s*TenantRole\.(\w+)/g,
      ),
    ].map((match) => match[1] ?? ''),
  ),
].sort();

/**
 * Shared ⇄ Zod parity for the high-risk unions.
 *
 * `shared/` had ZERO tests, so the two representations of every enum — the
 * shared TypeScript union (consumed by the UI and by every domain interface) and
 * the server's Zod schema (the only thing that validates a request) — were kept
 * in step by hand and by nothing else. They had already drifted: the audit
 * `action` list and the `sort` direction were hand-copied literals, and the (now
 * removed) `AuditEventResponseSchema` widened `entityType`/`action` straight back
 * to `z.string()`.
 *
 * ## What this actually catches
 *
 * A naive parity test is a tautology: if the schema is written as
 * `z.enum(TenantRoleValues)`, comparing it against `TenantRoleValues` proves
 * nothing. So the checks below run on three axes, and the ones with teeth are
 * the ones a tautology cannot fake:
 *
 *  1. **Mutual assignability at compile time** (see {@link PARITY}). A schema
 *     that silently becomes a subset (a member dropped) or a superset (a literal
 *     list pasted in, `z.string()`, …) of the shared union stops type-checking,
 *     so `npm run typecheck` fails — no test needs to be run. This is what
 *     catches the exact regression this file exists for: someone REPLACING a
 *     derived `z.enum(SomeSharedValues)` with a hand-written copy.
 *  2. **Rejection of foreign values.** Every value belonging to a DIFFERENT
 *     union in this file, plus case/whitespace/garbage variants, must be
 *     rejected. This is a statement about the runtime data Zod actually
 *     enforces, and a widened schema fails it while an exact one passes.
 *  3. **Acceptance of every shared value**, so a schema that accidentally
 *     NARROWS fails even when the dropped member happens to be unused today.
 */

/** `true` only when A and B are assignable to each other. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _optionalOf = <T>(value: T | undefined) => value;

/**
 * Compile-time parity gates. Each key is annotated `true`, so the assignment
 * only type-checks while the schema's inferred type and the shared type are the
 * SAME type. Exported so `noUnusedLocals` treats them as the public surface of
 * this module (they carry no runtime weight — the value is a literal `true`).
 */
export const PARITY = {
  /** Inviteable tenant roles: ADMIN + MEMBER, deliberately NOT the full union. */
  inviteMemberRole: true satisfies MutuallyAssignable<
    z.infer<typeof InviteMemberSchema.shape.role>,
    'ADMIN' | 'MEMBER'
  >,
  updateMemberRole: true satisfies MutuallyAssignable<
    NonNullable<z.infer<typeof UpdateMemberSchema.shape.role>>,
    'ADMIN' | 'MEMBER'
  >,
  /** The FULL TenantRole, on the read-boundary schema. */
  tenantRole: true satisfies MutuallyAssignable<z.infer<typeof MyInvitationSchema.shape.role>, TenantRole>,
  memberStatus: true satisfies MutuallyAssignable<z.infer<typeof MyInvitationSchema.shape.status>, MemberStatus>,
  sprintStatus: true satisfies MutuallyAssignable<
    NonNullable<z.infer<typeof UpdateSprintSchema.shape.status>>,
    SprintStatus
  >,
  // `CreateSprintSchema` has no `status` field (a new sprint is always FUTURE) —
  // only the UPDATE path sets one, so that is the schema under test.
  auditAction: true satisfies MutuallyAssignable<
    NonNullable<z.infer<typeof AuditQuerySchema.shape.action>>,
    AuditAction
  >,
  auditEntityType: true satisfies MutuallyAssignable<
    NonNullable<z.infer<typeof AuditQuerySchema.shape.entityType>>,
    AuditEntityType
  >,
  auditSort: true satisfies MutuallyAssignable<NonNullable<z.infer<typeof AuditQuerySchema.shape.sort>>, SortDirection>,
  filterSortDirection: true satisfies MutuallyAssignable<
    z.infer<typeof CreateFilterSchema.shape.sort.shape.direction>,
    SortDirection
  >,
  taskPriority: true satisfies MutuallyAssignable<
    z.infer<typeof CreateTaskSchema.shape.priorityLevel>,
    TaskPriorityLevel
  >,
  relationshipType: true satisfies MutuallyAssignable<
    z.infer<typeof CreateTaskRelationshipSchema.shape.type>,
    TaskRelationshipType
  >,
  themeMode: true satisfies MutuallyAssignable<
    NonNullable<z.infer<typeof UpdateUserGlobalSettingsSchema.shape.themeMode>>,
    ThemeMode
  >,
} as const;

void _optionalOf;

/** Every string value from every union covered here, for the rejection probes. */
const ALL_KNOWN_STRINGS: string[] = [
  ...TenantRoleValues,
  ...MemberStatusValues,
  ...SprintStatusValues,
  ...InvitationStatusValues,
  ...TaskRelationshipTypeValues,
  ...AuditActionValues,
  ...AuditEntityTypeValues,
  ...SortDirectionValues,
  'auto',
  'light',
  'dark',
];
/** Values that belong to no union, including case and whitespace near-misses. */
const NOT_A_MEMBER = ['Owner', 'owner', 'MEMBER ', ' MEMBER', 'MEMBERS', 'ACTIVATED', '', 'true', '1'];

describe('shared ⇄ Zod parity (F22)', () => {
  /**
   * The generic runtime assertion, driven off the OWNED value list.
   *
   * @param label   human name used in the failure message
   * @param schema  the schema under test
   * @param owned   the values this schema is supposed to accept
   * @param foreign extra values to reject (defaults to every other known string)
   */
  const assertParity = (
    label: string,
    schema: z.ZodType,
    owned: readonly unknown[],
    foreign: readonly unknown[] = [],
  ) => {
    const ownedKeys = new Set(owned.map(String));
    const others = [...ALL_KNOWN_STRINGS.filter((v) => !ownedKeys.has(v)), ...NOT_A_MEMBER, ...foreign];

    it(`${label}: accepts every shared value (${owned.length})`, () => {
      expect(owned.length).toBeGreaterThan(0);

      for (const value of owned) {
        expect(schema.safeParse(value).success, `${label} rejected its own member ${String(value)}`).toBe(true);
      }
    });

    it(`${label}: rejects all ${others.length} foreign values`, () => {
      for (const value of others) {
        expect(schema.safeParse(value).success, `${label} wrongly accepted ${JSON.stringify(value)}`).toBe(false);
      }
    });
  };

  describe('roles', () => {
    assertParity('InviteMemberSchema.role', InviteMemberSchema.shape.role, ['ADMIN', 'MEMBER']);
    assertParity('UpdateMemberSchema.role', UpdateMemberSchema.shape.role, ['ADMIN', 'MEMBER']);
    assertParity('MyInvitationSchema.role', MyInvitationSchema.shape.role, TenantRoleValues);

    it('the inviteable subset is decided by VALUE — reordering the shared tuple changes nothing', () => {
      // This used to assert `TenantRoleValues[1..2] === ['ADMIN','MEMBER']`, a
      // POSITIONAL claim: reordering the shared constant — a correct, behaviour-
      // preserving change — failed the suite, while widening the schema to every
      // role passed. The property is about the set the write boundaries accept,
      // derived from the schemas themselves.
      const inviteable = TenantRoleValues.filter((value) => InviteMemberSchema.shape.role.safeParse(value).success);
      const updatable = TenantRoleValues.filter((value) => UpdateMemberSchema.shape.role.safeParse(value).success);

      // Both write boundaries decide the same question and must answer it alike.
      expect(updatable).toEqual(inviteable);
      // It is a genuine subset, not "everything": the tenant's owner role is not
      // transferable by invitation (see `INVITEABLE_ROLES` in schemas/tenant.ts).
      expect(inviteable.length).toBeGreaterThan(0);
      expect(inviteable.length).toBeLessThan(TenantRoleValues.length);
      // The read boundary reports the full union, refused roles included.
      expect(TenantRoleValues.filter((v) => MyInvitationSchema.shape.role.safeParse(v).success)).toEqual([
        ...TenantRoleValues,
      ]);
    });

    it('no membership write path grants a role the write boundary refuses', () => {
      // The complement of the above, and the direction that had no guardrail: a
      // service that hard-codes a role into a membership (bypassing the schema)
      // would persist a value the request boundary cannot validate.
      const refused = new Set<string>(
        TenantRoleValues.filter((value) => !InviteMemberSchema.shape.role.safeParse(value).success),
      );

      for (const role of ROLES_HARDCODED_IN_WRITES) {
        expect(refused.has(role), `tenant-member.service.ts grants ${role}, which no schema accepts`).toBe(false);
      }
    });
  });

  describe('statuses', () => {
    assertParity('MyInvitationSchema.status', MyInvitationSchema.shape.status, MemberStatusValues);
    // `CreateSprintSchema` has no `status` field (a new sprint is always
    // FUTURE), so only the UPDATE path carries a status to validate.
    assertParity('UpdateSprintSchema.status', UpdateSprintSchema.shape.status, SprintStatusValues);
  });

  describe('audit', () => {
    assertParity('AuditQuerySchema.action', AuditQuerySchema.shape.action, AuditActionValues);
    assertParity('AuditQuerySchema.entityType', AuditQuerySchema.shape.entityType, AuditEntityTypeValues);
    assertParity('AuditQuerySchema.sort', AuditQuerySchema.shape.sort, SortDirectionValues);

    it('the audit action domain is exactly what the server writes to the audit log', () => {
      // Was a hand-copied content list (`['CREATED','DELETED','UPDATED']`), which
      // could only be edited by hand. Derived from the `action:` literals the
      // server actually persists, in both directions: a union member nothing
      // writes, and a written action the union does not declare (which would
      // fail to type-check at the audit boundary anyway) both fail.
      assertCorrespondence('AuditAction ⇄ audit writes', [...AuditActionValues], AUDIT_ACTIONS_WRITTEN);
    });

    it('the audit entity-type domain is exactly what the server writes to the audit log', () => {
      assertCorrespondence('AuditEntityType ⇄ audit writes', [...AuditEntityTypeValues], AUDIT_ENTITY_TYPES_WRITTEN);
    });
  });

  describe('task fields', () => {
    assertParity('CreateTaskSchema.priorityLevel', CreateTaskSchema.shape.priorityLevel, TASK_PRIORITY_LEVELS, [
      4,
      -1,
      '0',
      '1',
    ]);
    assertParity(
      'CreateTaskRelationshipSchema.type',
      CreateTaskRelationshipSchema.shape.type,
      TaskRelationshipTypeValues,
    );
  });

  describe('misc shared unions', () => {
    assertParity('CreateFilterSchema.sort.direction', CreateFilterSchema.shape.sort.shape.direction, [
      ...SortDirectionValues,
    ]);
    assertParity('UpdateUserGlobalSettingsSchema.themeMode', UpdateUserGlobalSettingsSchema.shape.themeMode, [
      'auto',
      'light',
      'dark',
    ]);
  });

  describe('the shared value tuples themselves are well-formed', () => {
    it('no union is empty or contains duplicates', () => {
      const tuples: Record<string, readonly string[]> = {
        TenantRoleValues,
        MemberStatusValues,
        SprintStatusValues,
        InvitationStatusValues,
        TaskRelationshipTypeValues,
        AuditActionValues,
        AuditEntityTypeValues,
        SortDirectionValues,
      };

      for (const [name, values] of Object.entries(tuples)) {
        expect(values.length, `${name} is empty`).toBeGreaterThan(0);
        expect(new Set(values).size, `${name} has duplicate members`).toBe(values.length);
      }
    });
  });
});
