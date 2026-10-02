/**
 * The counter collection is reachable from exactly one module.
 *
 * `rate_limit_counters` is the only collection in the product that no feature
 * reads. It holds, per bucket and per identity, how many authentication attempts
 * that identity has spent — so a reader of it learns WHICH EMAILS AND ADDRESSES
 * are being attacked, which is an enumeration oracle the rest of the system
 * deliberately refuses to be. The protection is structural rather than
 * cryptographic: the store is not exposed by a route, and the hash in the `_id`
 * only helps if nobody can enumerate the collection at all.
 *
 * Two properties are asserted, both by scanning the source rather than by
 * inspecting a running graph, because "who can reach this collection" is a
 * question about call sites and no unit test can observe it:
 *
 *   1. **Only the repository names it.** The composition root may open it (that
 *      is where collections are named) and the migration may declare its index
 *      (that is where indexes are declared). No service, route or middleware
 *      may, because a second caller is a second reader of the address book.
 *   2. **The authority service owns the decisions.** Every bucket probe the auth
 *      service makes must go through `RateLimitAuthorityService`; a fourth or
 *      fifth bucket added as a direct `createRateLimiter` call in `auth.service.ts`
 *      would be a ceiling the authoritative store does not know about.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(SRC, '..', '..');
/** Strip comments, so documenting the collection cannot satisfy or trip a scan. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }

  return out.sort();
}

const COLLECTION = 'rate_limit_counters';
/**
 * The places allowed to name the collection: the composition root (which is the
 * only place allowed to OPEN one — see P-01) and the migrations (which is the
 * only place allowed to declare its index).
 *
 * The repository is deliberately NOT on this list: it never names the
 * collection, it is handed the `Collection` at construction. That is the same
 * seam every other repository in the product uses, and it is why the repository
 * is not a reader of anything — it only ever writes the one document its key
 * selects.
 */
const ALLOWED_IN = new Set([join('container.ts'), join('db', 'migrations.ts')]);

describe('rate_limit_counters is reachable only through its repository', () => {
  it('no service, route, middleware or other repository names the collection', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const path = relative(SRC, file);

      return !ALLOWED_IN.has(path) && code(readFileSync(file, 'utf8')).includes(COLLECTION);
    });

    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it('the allow-list is not vacuous — the composition root and the migration do name it', () => {
    // If the allowed set stopped matching the code, the scan above would pass by
    // reading nothing, and a future reader would trust it.
    for (const path of ALLOWED_IN) {
      expect(code(readFileSync(join(SRC, path), 'utf8')), `${path} is allow-listed but names nothing`).toContain(
        COLLECTION,
      );
    }
  });

  it('every rate-limit decision in the auth service goes through the authority', () => {
    // The property is not "never mentions a limiter" — it is that the service
    // itself constructs no ceiling and no probe: every bucket is a method on the
    // authority, which is the only module that knows the tier stack and is the
    // only one that can refuse when the store cannot answer.
    const auth = code(readFileSync(join(SRC, 'services', 'auth.service.ts'), 'utf8'));

    expect(auth).not.toContain('createRateLimiter');

    // Every probe is `this.rateLimits.<bucket>`.
    const probes = [...auth.matchAll(/this\.rateLimits\.(\w+)\(/g)].map((match) => match[1]);

    expect(new Set(probes)).toEqual(new Set(['probeLogin', 'probeRegisterSource', 'probeForgotPassword']));
  });

  it('the authority is the only module that turns a scope into a counter key', () => {
    // Two modules able to derive a document key is one too many: they would be
    // free to disagree about the bucket prefix, and the prefix is the only thing
    // keeping two buckets' namespaces apart.
    const derivations = sourceFiles(SRC).filter((file) =>
      code(readFileSync(file, 'utf8')).includes('rateLimitCounterId('),
    );

    // The definition and the one call site inside the authority itself.
    expect(derivations.map((file) => relative(SRC, file))).toEqual([
      join('services', 'rate-limit-authority.service.ts'),
    ]);
  });
});
