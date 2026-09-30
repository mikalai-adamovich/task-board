/**
 * The mode-aware rate-limit ceiling.
 *
 * The defect was not the limiter, it was the ARITHMETIC: the effective ceiling
 * was "allowed attempts × number of instances", and the instance count was a
 * deploy flag nobody could see. These tests pin the arithmetic down, because it
 * is pure and therefore the only part of this that can be proven without a
 * Worker, a Durable Object or a deployment.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ASSUMED_INSTANCES,
  describeRateLimitScope,
  parseInstanceBudget,
  resolveRateLimitScope,
} from './rate-limit-scope.js';
import { createRateLimiter } from './rate-limiter.js';

const SRC_DIR = dirname(import.meta.filename);
const LOGIN_MAX = 10;

describe('parseInstanceBudget — a typo must not become a disabled ceiling', () => {
  it('accepts a positive integer', () => {
    expect(parseInstanceBudget('1')).toBe(1);
    expect(parseInstanceBudget('4')).toBe(4);
    expect(parseInstanceBudget(' 8 ')).toBe(8);
  });

  it('treats anything that is not a plain positive integer as UNDECLARED', () => {
    for (const raw of ['', '   ', '0', '-2', '2.5', '1e3', '0x10', 'many', 'NaN', undefined, null]) {
      expect(parseInstanceBudget(raw as string | undefined | null), `input: ${String(raw)}`).toBeNull();
    }
  });
});

describe('resolveRateLimitScope — the mode → ceiling mapping', () => {
  it('durable is a SHARED counter: one instance, the full ceiling, no operator input', () => {
    // This is the DEPLOYED mode (one stable DO identity), so production
    // behaviour is exactly what it was before this change.
    const scope = resolveRateLimitScope('durable', undefined, LOGIN_MAX);

    expect(scope).toEqual({ kind: 'shared', instances: 1, declared: true, effectiveCeiling: 10 });
  });

  it('a declared instance budget keeps the DEPLOYMENT-wide ceiling at the configured value', () => {
    // The whole point: 4 instances × a ceiling of 2 is 8 attempts for the
    // deployment, not 4 × 10 = 40. It lands UNDER the configured 10 because
    // the division rounds down — a stricter control, never a looser one, which
    // is the correct direction for an abuse ceiling. The residue is at most one
    // attempt per instance, so the control stays within `instances` of the
    // documented value however the operator declares it.
    const scope = resolveRateLimitScope('per-request', '4', LOGIN_MAX);

    expect(scope.kind).toBe('per-instance');
    expect(scope.instances).toBe(4);
    expect(scope.declared).toBe(true);
    expect(scope.effectiveCeiling).toBe(2);
    expect(scope.effectiveCeiling * scope.instances).toBeLessThanOrEqual(LOGIN_MAX);
    expect(LOGIN_MAX - scope.effectiveCeiling * scope.instances).toBeLessThan(scope.instances);
  });

  it('an instance budget that divides exactly reproduces the configured ceiling', () => {
    // 10 / 5 = 2 with no residue, so the deployment-wide control is exactly the
    // documented number — the case where the arithmetic is lossless.
    const scope = resolveRateLimitScope('per-request', '5', LOGIN_MAX);

    expect(scope.effectiveCeiling * scope.instances).toBe(LOGIN_MAX);
  });

  it('rounds DOWN, so the product never exceeds the configured ceiling', () => {
    // 10 / 3 = 3.33 → 3. 3 instances × 3 = 9, which is under 10: a stricter
    // control, never a looser one.
    const scope = resolveRateLimitScope('per-request', '3', LOGIN_MAX);

    expect(scope.effectiveCeiling).toBe(3);
    expect(scope.effectiveCeiling * scope.instances).toBeLessThanOrEqual(LOGIN_MAX);
  });

  it('falls back to a conservative ASSUMED count when nothing is declared', () => {
    // Assuming ONE instance in a mode that runs many would reproduce the exact
    // defect this removes (a silent ×N). The default is deliberately smaller
    // than the truth, and says so.
    const scope = resolveRateLimitScope('per-request', undefined, LOGIN_MAX);

    expect(scope.declared).toBe(false);
    expect(scope.instances).toBe(DEFAULT_ASSUMED_INSTANCES);
    expect(scope.effectiveCeiling).toBe(Math.max(1, Math.floor(LOGIN_MAX / DEFAULT_ASSUMED_INSTANCES)));
  });

  it('treats an UNSET mode as the app default, which is per-request (multi-instance)', () => {
    // `app.ts` documents the same default, so the limiter must not disagree
    // with it: an unset mode is not a licence to assume a single instance.
    expect(resolveRateLimitScope(undefined, undefined, LOGIN_MAX).kind).toBe('per-instance');
  });

  it('never divides a ceiling below 1 — a config mistake must not refuse every login', () => {
    const scope = resolveRateLimitScope('per-request', '50', 1);

    expect(scope.effectiveCeiling).toBe(1);
  });

  it('the singleton experiment is multi-instance too', () => {
    expect(resolveRateLimitScope('singleton', undefined, LOGIN_MAX).kind).toBe('per-instance');
  });
});

describe('the divided ceiling is what the limiter actually enforces', () => {
  it('a limiter probes against the effective ceiling, and its counters persist across calls', () => {
    const scope = resolveRateLimitScope('per-request', '4', LOGIN_MAX);
    const limiter = createRateLimiter(LOGIN_MAX, 60_000);

    // Two of the two-per-instance budget are allowed…
    expect(limiter('account:a@b.c', scope.effectiveCeiling).limited).toBe(false);
    expect(limiter('account:a@b.c', scope.effectiveCeiling).limited).toBe(false);
    // …and the third is refused, which is 8 of the 10 across 4 instances.
    expect(limiter('account:a@b.c', scope.effectiveCeiling).limited).toBe(true);
  });

  it('omitting the override keeps the configured ceiling (unchanged behaviour)', () => {
    const limiter = createRateLimiter(3, 60_000);

    for (let i = 0; i < 3; i += 1) {
      expect(limiter('k').limited).toBe(false);
    }

    expect(limiter('k').limited).toBe(true);
    expect(limiter('k', 1).limited).toBe(true);
  });
});

describe('the counter must NOT live in the Durable Object it protects (Q4)', () => {
  it('the limiter and its scope module reference no Durable Object binding', () => {
    // The rollback to `per-request` exists BECAUSE the Durable Object can be
    // the thing that is broken. A counter stored in that same Durable Object
    // would be unavailable exactly when the rollback is taken — the abuse
    // control would fail OPEN at the moment it is most needed. This is a
    // source-level guard because the property is architectural: no unit test
    // can observe "this module does not reach for the DO".
    for (const file of ['rate-limiter.ts', 'rate-limit-scope.ts']) {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');

      expect(source, `${file} must not reference a Durable Object`).not.toMatch(
        /MONGO_DO|DurableObjectNamespace|\.getDurableObject|env\.MONGO_DO/,
      );
    }
  });
});

describe('describeRateLimitScope — what an operator reads on /api/readyz', () => {
  it('says plainly that the deployed mode has a shared counter', () => {
    const scope = resolveRateLimitScope('durable', undefined, LOGIN_MAX);

    expect(describeRateLimitScope(scope, LOGIN_MAX)).toBe('shared counter (one instance) — ceiling 10 per window');
  });

  it('distinguishes a declared budget from an assumed one', () => {
    expect(describeRateLimitScope(resolveRateLimitScope('per-request', '4', LOGIN_MAX), LOGIN_MAX)).toContain(
      '4 declared instances',
    );
    expect(describeRateLimitScope(resolveRateLimitScope('per-request', undefined, LOGIN_MAX), LOGIN_MAX)).toContain(
      'undeclared',
    );
  });

  it('never mentions a secret — it is pure arithmetic over two non-secret values', () => {
    vi.useRealTimers();

    const described = describeRateLimitScope(resolveRateLimitScope('per-request', '4', LOGIN_MAX), LOGIN_MAX);

    expect(described).not.toMatch(/secret|token|password/i);
  });
});
