/**
 * The configuration the Worker cannot work without, named in one
 * place, REPORTED on the probe and ENFORCED at start-up.
 *
 * `AppEnv.Bindings` declares `MONGODB_URI` and `JWT_SECRET` as strings, which
 * is a TYPE-level promise the runtime does not keep: on Cloudflare a missing
 * secret binding is `undefined`, and a Worker that boots with no `JWT_SECRET`
 * will happily serve requests until the first one needs to sign a token. The
 * type says it is there; nothing says it IS.
 *
 * **The owner has now decided (option (a)): the Worker REFUSES
 * to start.** Reporting is right for a probe and wrong for a boot — a worker
 * signing tokens with an empty secret is a security posture, not a degraded
 * mode. So this module both computes the verdict ({@link inspectConfiguration},
 * which `/api/readyz` still reports) and asserts it
 * ({@link assertRequiredConfiguration}, which the Worker entrypoint calls
 * before it serves anything).
 *
 * The two halves are deliberately kept:
 *   - `assertRequiredConfiguration` is the BOOT gate. It runs once per Worker
 *     invocation, before routing, and throws. The consequence is a deployment
 *     that is DOWN rather than mis-configured-and-serving — chosen knowingly:
 *     the failure is loud and immediate instead of surfacing on the first user
 *     who tries to sign in.
 *   - `inspectConfiguration` is the PROBE verdict. It still runs and still
 *     reports, because a probe that could not run is a probe that cannot say
 *     why.
 *
 * Only the NAMES are ever inspected. A value is never read, logged, echoed or
 * compared — {@link ConfigurationVerdict.missing} carries a variable name, and
 * the guardrail asserts that is all it can carry. {@link MissingConfigurationError}
 * obeys the same rule: its message names the variables and nothing else, so a
 * boot failure cannot become a secret-exfiltration path through a stack trace.
 */

/** The variables the Worker genuinely cannot serve traffic without. */
export const REQUIRED_CONFIG = ['MONGODB_URI', 'JWT_SECRET'] as const;

export type RequiredConfigName = (typeof REQUIRED_CONFIG)[number];

export interface ConfigurationVerdict {
  /** True when every required variable is present. */
  ok: boolean;
  /** The NAMES of the missing variables — never their values. */
  missing: RequiredConfigName[];
}

/**
 * A present-but-empty value is a missing value. `wrangler secret put` with an
 * empty string, a `vars:` entry set to `""` and an absent binding are the same
 * failure from the Worker's point of view: the code path that reads the variable
 * finds nothing there. Treating only `undefined` as missing would let a
 * whitespace-only secret pass a probe that says "configured".
 */
function isPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Inspect an environment for {@link REQUIRED_CONFIG}.
 *
 * Takes the environment as an argument rather than reading a global, so the
 * answer is a pure function of what it is given — which is what makes the
 * absent-input case testable at all.
 */
export function inspectConfiguration(env: Record<string, unknown>): ConfigurationVerdict {
  const missing = REQUIRED_CONFIG.filter((name) => !isPresent(env[name]));

  return { ok: missing.length === 0, missing };
}

/** The verdict for the environment the Worker is actually running in. */
export function currentConfiguration(env: Record<string, unknown> = process.env): ConfigurationVerdict {
  return inspectConfiguration(env);
}

/**
 * Thrown by {@link assertRequiredConfiguration} when a required variable is
 * absent or blank.
 *
 * A dedicated class rather than a bare `Error` so the boot failure is
 * identifiable in a log or a test without matching on message text, and so
 * nothing downstream mistakes it for an application error to be rendered into
 * a 500 envelope — at this point there is no request and no client.
 */
export class MissingConfigurationError extends Error {
  /** Variable NAMES only. Never a value, never a length, never a prefix. */
  readonly missing: readonly RequiredConfigName[];

  constructor(missing: readonly RequiredConfigName[]) {
    super(
      `Refusing to start: required configuration is missing or empty: ${missing.join(', ')}. ` +
        'Set them as Worker secrets (wrangler secret put <NAME>) or vars before deploying.',
    );
    this.name = 'MissingConfigurationError';
    this.missing = missing;
  }
}

/**
 * The BOOT gate. Throws {@link MissingConfigurationError} when
 * any of {@link REQUIRED_CONFIG} is absent or blank; returns normally otherwise.
 *
 * Called from the Worker entrypoint (`server/src/index.ts`) before any request
 * is dispatched, and from the Durable Object's fetch — the DO is a separate
 * isolate with its own entry, and a Worker that proxies to a DO which then
 * boots unconfigured has not been fixed by checking only the outer layer.
 *
 * The consequence, stated so it is a decision and not a surprise: a
 * misconfigured deployment answers NOTHING. Every request — including
 * `/api/health` and `/api/readyz` — fails, because the process refuses to run.
 * That is the point: the alternative is a green deployment that cannot sign a
 * token.
 */
export function assertRequiredConfiguration(env: Record<string, unknown>): void {
  const { ok, missing } = inspectConfiguration(env);

  if (!ok) {
    throw new MissingConfigurationError(missing);
  }
}
