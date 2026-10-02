/**
 * The deployment-mode half of the rate limiter.
 *
 * ## The problem this module exists to answer
 *
 * `createRateLimiter` (`./rate-limiter.ts`) keeps its counters in ordinary
 * process memory, so its effective ceiling is
 *
 *     allowed attempts × number of instances serving the request
 *
 * — a product the repository does not control and, until now, did not even
 * record. Production runs `DB_CLIENT_MODE=durable`, which resolves ONE stable
 * Durable Object identity (`index.ts`), so the instance count is 1 and the
 * ceiling is exactly what the constant says. The documented "proven rollback"
 * is `per-request`, where each isolate gets its own counters and the ceiling
 * multiplies by an unbounded, platform-chosen N. That is precisely the path a
 * person reaches for at 3 a.m. when the Durable Object is misbehaving, so the
 * failure mode is "the abuse ceiling silently grew at the worst moment".
 *
 * ## What this module does about it
 *
 * It makes the counter's SCOPE a function of the deployment mode instead of an
 * accident of it:
 *
 *   - `durable`  → ONE shared counter for the whole deployment. The in-process
 *                  map is the shared store, because the process IS the
 *                  deployment. No extra I/O, no new binding, and the ceiling is
 *                  unchanged from today.
 *   - anything else (`per-request`, `singleton`, unset) → the counter is scoped
 *                  so that the CEILING stays the configured number rather than
 *                  growing with the instance count, and the deployment is told,
 *                  loudly, that the ceiling it is relying on is per-instance.
 *
 * Concretely, in a multi-instance mode {@link resolveRateLimitScope} divides
 * the per-instance budget by the operator-declared instance count
 * (`RATE_LIMIT_INSTANCE_BUDGET`), so `N instances × (limit / N)` = `limit`. The
 * division is deliberately fail-SAFE: the operator under-declares N and the
 * ceiling is *tighter* than intended (annoying, not dangerous); they
 * over-declare and it is looser. That is the right direction for a control whose
 * purpose is to refuse abuse, and it is why the declared budget is surfaced on
 * `/api/readyz` rather than hidden in a log line.
 *
 * ## What this module governs now
 *
 * The exact counter EXISTS: MongoDB is the authority for the four
 * authentication buckets (`services/rate-limit-authority.service.ts`), it counts
 * per document, and it therefore does not multiply by instances — so none of the
 * arithmetic below is applied to the ENFORCED ceiling, which is the configured
 * constant (10 / 30 / 20 / 5) in every `DB_CLIENT_MODE`. MongoDB is reachable in
 * every mode, which is exactly the property a Durable-Object- or KV-backed
 * counter could not have had: the rollback to `per-request` is taken when the
 * Durable Object is the thing that is broken, so a counter stored in that same
 * Durable Object would be unavailable precisely when it is most needed.
 *
 * What this module is for is REPORTING the deployment's instance budget, and it
 * is the reason the arithmetic is still here: no probe consumes `effectiveCeiling`
 * any more. The authority's in-process limiter is the ADVISORY tier alone — it
 * may refuse a saturated key and may never admit one — and a counter-store fault
 * is refused rather than handed to a per-instance map
 * (`services/rate-limit-authority.service.ts`). A ceiling only an operator cannot
 * account for is not a ceiling, so the degraded path no longer exists to divide
 * for. What remains is the number an operator reads on `/api/readyz`, which
 * still says how many instances this deployment runs and what the declared
 * budget implies — the fact that the enforced ceiling does NOT depend on either
 * number is the more important half of that line, and it is stated there too.
 *
 * ## Why it is pure
 *
 * `resolveRateLimitScope` takes the mode as an argument and returns a value. It
 * reads no global and no `process.env`, so the mode → ceiling arithmetic is
 * testable without a Worker, a Durable Object or a deployment — which is the
 * only reason this can be proven at all in a unit test.
 */

/** The deployment modes the limiter distinguishes. Mirrors `MongoClientMode`. */
export type DbClientMode = 'durable' | 'per-request' | 'singleton';

/**
 * The instance count assumed when a multi-instance mode is deployed and the
 * operator declared nothing.
 *
 * NOT 1. Assuming one instance in a mode that runs many would reproduce exactly
 * the defect this module exists to remove: the ceiling would silently be
 * `limit × N` while the code claimed `limit`. A deliberately conservative
 * default makes the real per-instance budget smaller and therefore the control
 * stricter — the fail-safe direction — and {@link resolveRateLimitScope} reports
 * `declared: false` so `/api/readyz` can say the number is a guess.
 */
export const DEFAULT_ASSUMED_INSTANCES = 4;

/** The environment variable an operator sets to declare the instance count. */
export const INSTANCE_BUDGET_VAR = 'RATE_LIMIT_INSTANCE_BUDGET';

export interface RateLimitScope {
  /** `shared` = one counter for the whole deployment; `per-instance` = one each. */
  kind: 'shared' | 'per-instance';
  /** The instance count the budget was divided by. Always ≥ 1. */
  instances: number;
  /** False when `instances` is {@link DEFAULT_ASSUMED_INSTANCES}, not declared. */
  declared: boolean;
  /**
   * The effective ceiling a PER-INSTANCE limiter configured with `maxRequests`
   * would enforce, i.e. `maxRequests` in `shared` mode and
   * `max(1, floor(maxRequests / instances))` otherwise. Rounded DOWN and floored
   * at 1, so the product of this and `instances` never exceeds `maxRequests`.
   *
   * REPORTED, not enforced: no probe applies it. The authentication ceiling is
   * the configured constant in every mode, because MongoDB counts per document
   * and the in-process tier may refuse but never admit — and this number is kept
   * because a per-instance counter is still what a deployment that reads it is
   * describing, not because anything counts against it.
   */
  effectiveCeiling: number;
}

/**
 * Parse the declared instance budget.
 *
 * Strict on purpose: a value that is not a positive integer is treated as
 * UNDECLARED (the conservative default) rather than coerced. A typo must not
 * become `NaN` and silently disable the ceiling, and `'0'` must not become a
 * division by zero.
 */
export function parseInstanceBudget(raw: string | undefined | null): number | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    return null;
  }

  // `Number` alone would accept '1e3', '0x10' and ' 12 '; a digit-only test
  // keeps the accepted syntax to what an operator would obviously mean.
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * THE mode → ceiling mapping. Pure; see the module docstring for the reasoning.
 *
 * @param mode the deployment's `DB_CLIENT_MODE` (undefined means the app's own
 *             default, `per-request`).
 * @param rawInstanceBudget the raw `RATE_LIMIT_INSTANCE_BUDGET` value, if any.
 * @param maxRequests the limiter's configured ceiling.
 */
export function resolveRateLimitScope(
  mode: string | undefined,
  rawInstanceBudget: string | undefined | null,
  maxRequests: number,
): RateLimitScope {
  // `durable` is the ONE mode in which the process is the deployment: the
  // Worker resolves a single DO identity, so the in-process map is already a
  // global counter. Today's behaviour, unchanged, with no operator input.
  if (mode === 'durable') {
    return { kind: 'shared', instances: 1, declared: true, effectiveCeiling: maxRequests };
  }

  const declared = parseInstanceBudget(rawInstanceBudget);

  if (declared === null) {
    const instances = DEFAULT_ASSUMED_INSTANCES;

    return {
      kind: 'per-instance',
      instances,
      declared: false,
      effectiveCeiling: scaleCeiling(maxRequests, instances),
    };
  }

  return {
    kind: 'per-instance',
    instances: declared,
    declared: true,
    effectiveCeiling: scaleCeiling(maxRequests, declared),
  };
}

/**
 * `floor(max / instances)`, floored at 1.
 *
 * The `Math.max(1, …)` matters for a limiter whose configured ceiling is
 * smaller than the declared instance count: without it the budget would be 0
 * and the limiter would refuse EVERY request including the first, turning a
 * configuration mistake into a total outage. One request per instance per window
 * is the least-wrong answer, and the number is reported so the operator sees it.
 */
function scaleCeiling(maxRequests: number, instances: number): number {
  return Math.max(1, Math.floor(maxRequests / instances));
}

/**
 * One line an operator (or `/api/readyz`) can read to know how many instances
 * this deployment runs the login limiter across. The ENFORCED ceiling is the
 * configured constant in every mode and is not described here, because it does
 * not vary with this number — an operator reading this line must also know that.
 */
export function describeRateLimitScope(scope: RateLimitScope, maxRequests: number): string {
  if (scope.kind === 'shared') {
    return `shared counter (one instance) — ceiling ${maxRequests} per window`;
  }

  const basis = scope.declared
    ? `${scope.instances} declared instances`
    : `${scope.instances} assumed instances (undeclared)`;

  return `per-instance counter, ${basis} — ceiling ${scope.effectiveCeiling} per instance, ~${maxRequests} deployment-wide`;
}
