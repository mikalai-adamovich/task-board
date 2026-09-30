/**
 * The Worker REFUSES TO START without its required
 * configuration, and the readiness probe still reports the verdict.
 *
 * ── What changed ─────────────────────────────────────────────────────────────
 * `AppEnv.Bindings` declares `MONGODB_URI` and `JWT_SECRET` as strings. That is
 * a TYPE-level promise the runtime does not keep: on Cloudflare a missing
 * secret binding is simply absent, and before this change a Worker booted with
 * no signing secret, served every request, and failed only on the first login
 * that needed to sign a token. The type said it was there; nothing said it IS.
 *
 * The owner has now decided: throw at start-up. Reporting is
 * right for a probe and wrong for a boot — a worker signing tokens with an
 * empty secret is a security posture, not a degraded mode. The trade-off is
 * known and chosen: a misconfigured deployment is DOWN rather than
 * mis-configured-and-serving, and the failure names the missing variables on the
 * first request instead of on a user's first sign-in.
 *
 * ── The consequence is asserted, not assumed ─────────────────────────────────
 * The last test in this file drives the real Worker entrypoint with an
 * unconfigured environment and shows that it serves NOTHING — not the liveness
 * endpoints, not the readiness probe. That is the deliberate part. Exempting
 * `/api/health` would recreate exactly the failure the decision closed: a
 * deployment green on every signal the system exposes, and still unable to sign
 * a token.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_CONFIG,
  MissingConfigurationError,
  assertRequiredConfiguration,
  inspectConfiguration,
} from './runtime-config.js';

/**
 * `index.ts` re-exports the Durable Object, and `do/mongo-do.ts` imports
 * `cloudflare:workers` — a module that exists only inside workerd. Stubbing it
 * lets the REAL Worker entrypoint be driven here, which is the point: the boot
 * gate's consequence ("this deployment serves nothing") is a property of the
 * entrypoint, not of the helper, and a test of the helper alone would not show
 * it. The DO's own gate is asserted by reading its source, below.
 */
vi.mock('../do/mongo-do.js', () => ({
  MongoHonoDurableObject: class {
    fetch(): Promise<Response> {
      return Promise.resolve(new Response('stub'));
    }
  },
}));

const { default: worker } = await import('../index.js');
const COMPLETE = { MONGODB_URI: 'mongodb://localhost:27017/taskboard', JWT_SECRET: 'a-signing-secret' } as const;

describe('N-4: the required configuration set', () => {
  it('is exactly MONGODB_URI and JWT_SECRET — no more, no fewer', () => {
    // Option (c) in the decision — "require a wider set, including the mail
    // provider key" — was rejected because `RESEND_API_KEY` is legitimately
    // optional (the container falls back to a console mailer). Widening this
    // list would fail deploys that are working, so the set is pinned here: a
    // future addition has to change this test and say why it is not optional.
    expect([...REQUIRED_CONFIG]).toEqual(['MONGODB_URI', 'JWT_SECRET']);
  });

  it('is written down where a deployer will read it', async () => {
    // The decision said the throw "needs the required set written down
    // explicitly". This asserts the documentation exists and names both
    // variables — a required set that lives only in code is the gap the
    // decision was about.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const agents = readFileSync(join(dirname(import.meta.filename), '..', '..', '..', 'AGENTS.md'), 'utf8');

    expect(agents).toContain('MONGODB_URI');
    expect(agents).toContain('JWT_SECRET');
    expect(agents, 'AGENTS.md must say the Worker refuses to start without them').toMatch(
      /refuses to start|REQUIRED_CONFIGURATION|required configuration/i,
    );
  });
});

describe('N-4: the boot gate throws instead of serving', () => {
  it('passes when both variables are present', () => {
    expect(() => assertRequiredConfiguration({ ...COMPLETE })).not.toThrow();
  });

  it('throws when MONGODB_URI is absent', () => {
    // The fail-proof for the item: before the throw existed, this returned
    // normally and the Worker went on to serve with no database.
    expect(() => assertRequiredConfiguration({ JWT_SECRET: COMPLETE.JWT_SECRET })).toThrow(MissingConfigurationError);
  });

  it('throws when JWT_SECRET is absent — the security-relevant one', () => {
    // A Worker with no signing secret will happily serve reads and writes and
    // fail on the first token. That is the deployment this decision exists for.
    let caught: MissingConfigurationError | null = null;

    try {
      assertRequiredConfiguration({ MONGODB_URI: COMPLETE.MONGODB_URI });
    } catch (error) {
      caught = error as MissingConfigurationError;
    }

    expect(caught).toBeInstanceOf(MissingConfigurationError);
    expect(caught?.missing).toEqual(['JWT_SECRET']);
  });

  it('treats a present-but-EMPTY or whitespace-only value as missing', () => {
    // `wrangler secret put` with an empty string, a `vars:` entry set to `""`
    // and an absent binding are the same failure from the Worker's point of
    // view: the code that reads the variable finds nothing there. A gate that
    // only tested `undefined` would pass a deployment that cannot work.
    expect(() => assertRequiredConfiguration({ ...COMPLETE, JWT_SECRET: '' })).toThrow(MissingConfigurationError);
    expect(() => assertRequiredConfiguration({ ...COMPLETE, JWT_SECRET: '   ' })).toThrow(MissingConfigurationError);
  });

  it('names EVERY missing variable, not just the first', () => {
    let caught: MissingConfigurationError | null = null;

    try {
      assertRequiredConfiguration({});
    } catch (error) {
      caught = error as MissingConfigurationError;
    }

    // A deployer fixing a misconfigured Worker should learn everything that is
    // wrong in one pass, not one variable per deploy.
    expect(caught?.missing).toEqual(['MONGODB_URI', 'JWT_SECRET']);
  });

  it('never puts a VALUE in the error — names only', () => {
    // A boot failure surfaces in a log, a platform error page and a stack
    // trace. A connection string or a signing secret in any of those would turn
    // a fail-fast into a disclosure.
    const uri = 'mongodb://user:hunter2@cluster.example/prod?retryWrites=true';
    const secret = 'super-secret-signing-key';
    let message = '';

    try {
      assertRequiredConfiguration({ MONGODB_URI: uri });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain(uri);
    expect(message).not.toContain(secret);
    expect(message).toContain('JWT_SECRET');
  });
});

describe('N-4: the readiness probe still reports the verdict', () => {
  it('inspectConfiguration is unchanged and still returns names, not values', () => {
    // The boot gate is ADDITIVE. The probe half must keep working: a
    // probe that could not run would be a probe that could not say why, and the
    // route is reachable in local and test deployments where the Worker
    // entrypoint is not.
    expect(inspectConfiguration({ ...COMPLETE })).toEqual({ ok: true, missing: [] });
    expect(inspectConfiguration({ MONGODB_URI: COMPLETE.MONGODB_URI })).toEqual({ ok: false, missing: ['JWT_SECRET'] });
  });

  it('the probe verdict and the boot gate agree on what "missing" means', () => {
    // Two functions, one definition of absence. If they diverged, a deployment
    // could pass the gate and be reported as unconfigured — or, worse, be told
    // it is configured and then be unable to start.
    const environments: Record<string, unknown>[] = [
      {},
      { MONGODB_URI: '' },
      { JWT_SECRET: '  ' },
      { MONGODB_URI: COMPLETE.MONGODB_URI, JWT_SECRET: COMPLETE.JWT_SECRET },
    ];

    for (const env of environments) {
      const { ok } = inspectConfiguration(env);
      const throws = (() => {
        try {
          assertRequiredConfiguration(env);
          return false;
        } catch {
          return true;
        }
      })();

      expect(throws, `gate/verdict disagree for ${JSON.stringify(Object.keys(env))}`).toBe(!ok);
    }
  });
});

describe('N-4: the consequence is a deployment that is DOWN, not serving', () => {
  /** The real Worker entrypoint, with no Durable Object binding needed. */
  function fetchWorker(env: Record<string, unknown>, path = '/api/ping') {
    return worker.fetch(
      new Request(`https://api.example.test${path}`),
      env as never,
      {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext,
    );
  }

  it('refuses EVERY path, including liveness and readiness', async () => {
    // The deliberate consequence, asserted rather than described. Before the
    // gate, `/api/health` answered 200 on a Worker that could not sign a
    // token — a deployment green on every signal the system exposes.
    for (const path of ['/api/ping', '/api/health', '/api/readyz', '/api/tenants']) {
      await expect(fetchWorker({ MONGODB_URI: COMPLETE.MONGODB_URI }, path), path).rejects.toThrow(
        MissingConfigurationError,
      );
    }
  });

  it('the boot failure happens BEFORE routing, so it cannot depend on a route', async () => {
    // A gate mounted inside the app would be reachable only for matched routes;
    // an unmatched path would answer 404 and an unknown path would never be
    // checked at all.
    await expect(fetchWorker({}, '/api/a/path/that/does/not/exist')).rejects.toThrow(MissingConfigurationError);
  });

  it('a CONFIGURED worker gets past the gate (and fails later, on the database, not on config)', async () => {
    // The negative control: without it, "everything throws" would satisfy every
    // test above. The configured Worker must NOT throw MissingConfigurationError.
    // It cannot complete the request here (there is no real MongoDB and no
    // Durable Object in a unit test), which is exactly why the assertion is on
    // the ERROR TYPE rather than the status.
    let caught: unknown = null;

    try {
      await fetchWorker({ ...COMPLETE }, '/api/ping');
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(MissingConfigurationError);
  });

  it('the gate is the FIRST statement of the entrypoint, before the DO decision', async () => {
    // Reading the source proves the ordering. In `durable` mode the routing
    // decision touches `env.MONGO_DO` first, so a gate placed after it would
    // blow up on a missing namespace rather than on the missing secret — the
    // wrong error, naming the wrong thing.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const source = readFileSync(join(dirname(import.meta.filename), '..', 'index.ts'), 'utf8');
    const gateAt = source.indexOf('assertRequiredConfiguration(env');
    const routingAt = source.indexOf('shouldProxyToDurable(env.DB_CLIENT_MODE');

    expect(gateAt, 'index.ts must call assertRequiredConfiguration').toBeGreaterThan(-1);
    expect(gateAt, 'the boot gate must run before the routing decision').toBeLessThan(routingAt);
  });

  it('the Durable Object asserts too — it is a second entry into the app', async () => {
    // In `durable` mode the DO runs the whole Hono app in its own isolate. A
    // gate in the Worker alone would still let an unconfigured DO build a
    // service graph, so both entrypoints assert.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const source = readFileSync(join(dirname(import.meta.filename), '..', 'do', 'mongo-do.ts'), 'utf8');

    expect(source).toContain('assertRequiredConfiguration(this.env');
    expect(source.indexOf('assertRequiredConfiguration(this.env')).toBeLessThan(source.indexOf('app.fetch(request'));
  });
});
