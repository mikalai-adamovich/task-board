// Length bounds the SERVER enforces and the CLIENT mirrors.
//
// Why constants and not a schema: `@task-board/shared` is runtime-library free
// (no Zod), and the UI cannot import a Zod schema — `shared/package.json` has
// no dependencies, which is exactly why every bound used to be hand-typed
// twice and only agreed by coincidence.
//
// The server derives its Zod validators from these numbers and the client
// derives its form rules from them, so editing a bound in one place moves both
// sides. `server/src/testing/shared-resolution.guardrail.test.ts` and
// `ui/src/app/shared/testing/shared-contract.spec.ts` assert the parity from
// each side, so a side that stops honouring the constant fails its own suite.

/** Tenant name bound (server: `nonEmptyString` on create/update/read). */
export const TENANT_NAME_MAX_LENGTH = 200;

/** Tenant description bound (server: `optionalString` / `nullableOptionalString`). */
export const TENANT_DESCRIPTION_MAX_LENGTH = 120;
