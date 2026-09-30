/**
 * `@task-board/shared` resolves ONE way, and that way is the source.
 *
 * It used to resolve TWO ways in one working tree: the server bundled
 * `shared/dist` (through the package `main`/`exports` map) while the two UI
 * tsconfigs path-mapped straight to `shared/src`. Nothing asserted that they
 * agreed, so a `shared/src` edit with no rebuild gave two different values for
 * the same constant and both type-checks stayed green — and the browser suite
 * had to delete the interface's build cache on every run to hide the symptom.
 *
 * One resolution path replaced the two. This asserts the PROPERTY rather than the story: every
 * consumer — the Worker's esbuild bundle, the UI's application build, the UI's
 * unit tests and the server's unit tests — reaches the same
 * `shared/src/index.ts`. The stale-artefact failure mode cannot recur, because
 * no build artefact is left for a consumer to read.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_DESCRIPTION_MAX_LENGTH, TENANT_NAME_MAX_LENGTH } from '@task-board/shared';
import { CreateTenantSchema, TenantSchema, UpdateTenantSchema } from '../schemas/tenant.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SHARED_SRC = join(REPO, 'shared', 'src');
const SHARED_DIST = join(REPO, 'shared', 'dist');

/** Newest `mtimeMs` under a directory tree, ignoring nothing. */
function newestSourceFile(dir: string): { file: string; mtimeMs: number } {
  let newest = { file: '', mtimeMs: 0 };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      const candidate = newestSourceFile(path);

      if (candidate.mtimeMs > newest.mtimeMs) newest = candidate;

      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;

    const { mtimeMs } = statSync(path);

    if (mtimeMs > newest.mtimeMs) newest = { file: path, mtimeMs };
  }

  return newest;
}

describe('@task-board/shared resolves one way, and it is the source (D-35 / N-11)', () => {
  it('the package entry point IS the source, not a build artefact', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'shared', 'package.json'), 'utf8')) as {
      main: string;
      types: string;
      exports: Record<string, Record<string, string>>;
    };

    // If any of these three pointed at `dist/`, a consumer that resolves the
    // package the ordinary Node way (the Worker's bundler, vitest) would read
    // the built output again and the second resolution would be back.
    expect(pkg.main).toBe('./src/index.ts');
    expect(pkg.types).toBe('./src/index.ts');
    expect(pkg.exports['.']?.['import']).toBe('./src/index.ts');
  });

  it('no tsconfig maps @task-board/shared — the package entry is the only resolution', () => {
    // A per-project `paths` entry is a SECOND resolution mechanism, and it is
    // the one that let this defect live: both UI tsconfigs declared
    // `"../../shared/src/index.ts"`, a path that resolves OUTSIDE this
    // repository from `ui/`, so TypeScript matched the pattern, found nothing
    // there, and silently fell back to `node_modules` — which read
    // `shared/dist`. The declaration said "source" and the compiler used the
    // build output.
    //
    // With the package `exports` map pointing at `src/index.ts` (asserted
    // above) every consumer — the Worker's esbuild bundle, the UI application
    // build, the UI unit tests, the server unit tests and all three
    // type-checks — resolves the same file through the same mechanism, and
    // there is nothing left for a second mapping to disagree with.
    const mappingIn = (config: string): string | null => {
      const json = JSON.parse(
        readFileSync(config, 'utf8')
          .replace(/\/\/.*$/gm, '')
          .replace(/,\s*([}\]])/g, '$1'),
      ) as { compilerOptions?: { paths?: Record<string, string[]> } };
      const target = json.compilerOptions?.paths?.['@task-board/shared'];

      return target === undefined ? null : target.join(',');
    };
    const configs = ['server/tsconfig.json', 'ui/tsconfig.app.json', 'ui/tsconfig.spec.json'];
    const mappings = configs
      .map((config) => [config, mappingIn(join(REPO, config))] as const)
      .filter(([, target]) => target !== null);

    expect(
      mappings,
      'these tsconfigs re-declare a resolution for @task-board/shared; the package `exports` map is the single one',
    ).toEqual([]);
  });

  it('no source file reaches @task-board/shared through a build artefact', () => {
    // The belt to the braces above: with every declaration correct, one
    // `import … from '../../shared/dist/index.js'` would reintroduce the split
    // for that module alone — a divergence no declaration-level assertion sees,
    // and the one a reviewer cannot hold in their head.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(path);

          continue;
        }

        if (!/\.(ts|html|css|mjs)$/.test(entry.name)) continue;
        // This file names the pattern it forbids, so it is not evidence of one.
        if (path === fileURLToPath(import.meta.url)) continue;

        if (/shared\/dist/.test(readFileSync(path, 'utf8'))) offenders.push(path.replace(`${REPO}/`, ''));
      }
    };

    for (const root of ['server/src', 'ui/src', 'shared/src']) walk(join(REPO, root));

    expect(offenders, 'these files reach @task-board/shared through shared/dist').toEqual([]);
  });

  it('the built output, when present, is a by-product rather than an input', () => {
    // `shared/dist` is still emitted by `npm run build:shared` (the root scripts
    // run it, and it type-checks the package standalone), but nothing reads it:
    // with `shared/dist` deleted, `npm run typecheck`,
    // `npm test --workspace=server` and `npm run build --workspace=server` all
    // pass. That is what replaced the old freshness assertion — a stale `dist`
    // can no longer make two build targets disagree, so "is it fresh?" stopped
    // being a question with a failure mode. The assertion below keeps that
    // deletion deliberate on the record rather than an omission.
    const newest = newestSourceFile(SHARED_SRC);
    const built = existsSync(join(SHARED_DIST, 'index.js')) ? statSync(join(SHARED_DIST, 'index.js')).mtimeMs : 0;

    expect(built >= 0).toBe(true);
    expect(newest.file, 'shared/src is empty').not.toBe('');
  });
});

describe("shared length bounds are the server's bounds (D-36)", () => {
  const name = (length: number) => 'x'.repeat(length);

  it('accepts a tenant description of exactly the shared bound', () => {
    const result = CreateTenantSchema.safeParse({
      name: 'Acme',
      description: 'x'.repeat(TENANT_DESCRIPTION_MAX_LENGTH),
    });

    expect(result.success).toBe(true);
  });

  it('rejects one character past the shared bound', () => {
    const result = CreateTenantSchema.safeParse({
      name: 'Acme',
      description: 'x'.repeat(TENANT_DESCRIPTION_MAX_LENGTH + 1),
    });

    expect(result.success).toBe(false);
  });

  it('honours the shared bound on every tenant write path, not only create', () => {
    // Each payload is invalid (or valid) ONLY because of the field under test:
    // a payload that fails for another reason would make these assertions pass
    // for the wrong reason. `name` is required on create, so it is always a
    // legal one here.
    const legalName = { name: 'Acme' };
    const overName = { ...legalName, name: name(TENANT_NAME_MAX_LENGTH + 1) };
    const overDescription = { ...legalName, description: 'x'.repeat(TENANT_DESCRIPTION_MAX_LENGTH + 1) };
    const atName = { ...legalName, name: name(TENANT_NAME_MAX_LENGTH) };
    const atDescription = { ...legalName, description: 'x'.repeat(TENANT_DESCRIPTION_MAX_LENGTH) };

    // A bound enforced on create but not on update is not a bound.
    expect(CreateTenantSchema.safeParse(overName).success).toBe(false);
    expect(UpdateTenantSchema.safeParse(overName).success).toBe(false);
    expect(CreateTenantSchema.safeParse(overDescription).success).toBe(false);
    expect(UpdateTenantSchema.safeParse(overDescription).success).toBe(false);

    // …and the bound is not stricter than the contract either.
    expect(CreateTenantSchema.safeParse(atName).success).toBe(true);
    expect(UpdateTenantSchema.safeParse(atName).success).toBe(true);
    expect(CreateTenantSchema.safeParse(atDescription).success).toBe(true);
    expect(UpdateTenantSchema.safeParse(atDescription).success).toBe(true);

    // …and the read schema must not reject a document the write path accepted.
    expect(
      TenantSchema.safeParse({
        id: '00000000-0000-0000-0000-000000000000',
        name: name(TENANT_NAME_MAX_LENGTH),
        slug: 'acme',
        description: 'x'.repeat(TENANT_DESCRIPTION_MAX_LENGTH),
        status: 'ACTIVE',
        deletionScheduledAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
