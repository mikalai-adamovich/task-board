/**
 * a11y guardrails for document structure.
 *
 * Two rules, both asserted against the sources because they are about the shape
 * of the whole app rather than one rendered instance:
 *
 * 1. Every route that renders a page component must declare a `title`. Without it
 *    the document title never changes and a screen-reader user navigating
 *    between, say, "Project A" and "Project B" gets no announcement. Titles are
 *    translation KEYS — `TranslocoTitleStrategy` resolves them — so each one is
 *    also checked against the real `en.json` catalogue.
 * 2. Every page must render exactly one `<h1>`. More than one breaks the heading
 *    outline; zero leaves the page without a name in the rotor.
 *
 * ## The page set is DERIVED, not listed
 *
 * This file used to keep a 32-entry `PAGE_TEMPLATES` literal whose only
 * self-check asserted that each listed path still existed. A literal that is
 * only checked for existence cannot notice that it stopped covering what it
 * claims, and it had already: it listed three templates no route renders
 * (`landing-page`, `welcome-view`, `invitation-view` — children of the
 * dashboard) and did not list the two routed pages whose own template holds no
 * heading at all (`dashboard.html`, `task-table.html`), so the root page and the
 * task table were never checked. Nothing was red.
 *
 * Both halves are now derived from the artefacts that define them:
 *
 *   - the page set comes from `app.routes.ts` (leaf routes only — a layout route
 *     renders no page of its own) resolved through each component's
 *     `templateUrl`;
 *   - the heading count is computed through COMPONENT COMPOSITION, because a
 *     page may legitimately own its `<h1>` in a child (the dashboard delegates
 *     to `ui-landing-page` / `ui-welcome-view` / `ui-invitation-view` in
 *     mutually exclusive branches; the task table delegates to
 *     `ui-task-table-header`). Counting only the page's own source would have
 *     reported 0 for both.
 *
 * The other direction is asserted too, with `assertCorrespondence`: a template
 * that carries an `<h1>` must be reachable from a page. A heading nobody renders
 * is a heading the outline claims exists and the user never reaches.
 *
 * Shared child components (filters, tables, cards) are deliberately NOT pages:
 * they compose INTO a page that owns its `<h1>`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Route } from '@angular/router';
import { routes } from './app.routes';
import { assertDeclaredCoversDerived } from './shared/testing/correspondence';

/** The application source root — every path in this file is relative to it, which
 *  is also how `app.routes.ts` spells its component specifiers. */
const APP = join(__dirname);
// The catalogue ships from `<repo>/ui/public`.
const CATALOGUE = readFileSync(join(APP, '..', '..', 'public', 'assets', 'i18n', 'en.json'), 'utf8');
const APP_REL = (absolute: string): string => relative(APP, absolute).split(sep).join('/');

/** Flatten a nested translation object into dot-separated leaf paths. */
function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return (
    key.split('.').reduce<unknown>((node, segment) => {
      return node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
    }, obj) !== undefined
  );
}

const EN: Record<string, unknown> = JSON.parse(CATALOGUE);

/**
 * Every route that lazily loads a LEAF page component. Layout routes (the ones
 * that only carry `children` — e.g. `w/:tenantSlug` → AppShell) render no page
 * of their own, so they neither get a `<h1>` nor a document title.
 */
function pageRoutes(all: Route[], prefix = ''): { path: string; route: Route }[] {
  return all.flatMap((route) => {
    const path = `${prefix}/${route.path ?? ''}`;
    const isLeaf = !!route.loadComponent && !route.children?.length;

    return [...(isLeaf ? [{ path, route }] : []), ...pageRoutes(route.children ?? [], path)];
  });
}

// ── the derived page set ──────────────────────────────────────────────────────

/**
 * Every route that lazily loads a component, in array order — LAYOUT routes
 * included, because the pairing below is positional over the whole array.
 */
function lazyRoutes(all: Route[], out: Route[] = []): Route[] {
  for (const route of all) {
    if (route.loadComponent) out.push(route);
    lazyRoutes(route.children ?? [], out);
  }

  return out;
}

/**
 * The module specifiers `app.routes.ts` imports, in source order. A
 * `loadComponent` thunk is a bundler construct — its own source is gone by the
 * time this test runs — so the module a route loads is recovered from the route
 * table's SOURCE and paired with the runtime routes positionally. Both sides
 * come from the same array in the same (depth-first) order, and the pairing is
 * only trusted while the two sequences have the same length: a route added
 * without a matching `import()`, or a stray `import()` outside the array, fails
 * the correspondence test below instead of silently shifting every later route
 * onto the wrong component.
 */
const ROUTE_IMPORTS = [...readFileSync(join(APP, 'app.routes.ts'), 'utf8').matchAll(/import\(\s*'([^']+)'\s*\)/g)].map(
  ([, specifier]) => (specifier as string).replace(/^\.\//, ''),
);
const lazy = lazyRoutes(routes);

/** The template the n-th lazily loaded route renders. */
function templateOfLazyRoute(index: number): string {
  const modulePath = ROUTE_IMPORTS[index];

  expect(
    modulePath,
    `app.routes.ts has ${ROUTE_IMPORTS.length} import() calls for ${lazy.length} lazy routes`,
  ).toBeTruthy();

  const file = join(APP, ...`${modulePath}.ts`.split('/'));
  const templateUrl = /templateUrl:\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1];

  expect(
    templateUrl,
    `${modulePath} declares no templateUrl — an inline template cannot be scanned for a heading`,
  ).toBeTruthy();

  return APP_REL(join(file, '..', templateUrl as string));
}

// ── the derived component index (for composition) ─────────────────────────────

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (entry.endsWith(ext) && !entry.endsWith('.spec.ts')) out.push(path);
  }

  return out;
}

/** `selector` → `templateUrl` for every component in the app. */
const SELECTOR_TO_TEMPLATE = new Map<string, string>();

for (const file of walk(APP, '.ts')) {
  const source = readFileSync(file, 'utf8');
  const selector = /selector:\s*'([^']+)'/.exec(source)?.[1];
  const templateUrl = /templateUrl:\s*'([^']+)'/.exec(source)?.[1];

  if (selector && templateUrl) SELECTOR_TO_TEMPLATE.set(selector, APP_REL(join(file, '..', templateUrl)));
}

const readTemplate = (rel: string): string =>
  readFileSync(join(APP, ...rel.split('/')), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** Every custom element opened in a template, as selector strings. */
function childSelectors(template: string): string[] {
  return [...template.matchAll(/<([a-z][a-z0-9-]*)\b/g)].map((match) => match[1] as string);
}

/**
 * How many `<h1>`s one render of this template can produce, following component
 * composition. The count is the MAXIMUM over the template's branches, because
 * `@if` / `@else` / `@switch` / `@case` / `@for` split a template into branches
 * that are mutually exclusive at runtime — the dashboard renders one of three
 * different views, so each branch owns exactly one heading and the page still
 * has one. `seen` breaks composition cycles.
 */
function headingCount(template: string, seen: ReadonlySet<string> = new Set()): number {
  if (seen.has(template)) return 0;

  const next = new Set(seen).add(template);
  const branches = readTemplate(template).split(/@(?:if|else if|else|switch|case|default|for)\b/);

  return branches.reduce((max, branch) => {
    const own = branch.match(/<h1\b/g)?.length ?? 0;
    const composed = childSelectors(branch).reduce(
      (sum, tag) =>
        sum + (SELECTOR_TO_TEMPLATE.has(tag) ? headingCount(SELECTOR_TO_TEMPLATE.get(tag) as string, next) : 0),
      0,
    );

    return Math.max(max, own + composed);
  }, 0);
}

/** Cap on how many child components one template's walk may compose, so a
 *  composition cycle that the `seen` guard misses cannot recurse forever. */
const MAX_WALK_STEPS = 5000;

/**
 * The heading levels one page renders, in document order, following component
 * composition.
 *
 * A skipped heading level is a property of the ORDER, not of the count, so the
 * quantity here is a sequence — `<h1>` then `<h3>` is wrong even though both are
 * "one heading", which is exactly what the previous `headingCount`-shaped rule
 * could not see.
 *
 * Two deliberate simplifications, both conservative:
 *
 *  - **Mutually exclusive branches are concatenated, not enumerated.** The
 *    dashboard renders one of three views; this reads as all three. A
 *    concatenation can never HIDE a skip (a skip inside a branch is still a
 *    skip inside the sequence) but it can invent one at a branch join, so a
 *    report names the template and the join rather than claiming a rendered
 *    instance. `@for` is not a branch at all: a loop repeats the same levels.
 *  - **Dialogs are excluded.** `*hlmDialogPortal` content is a separate
 *    surface instantiated only while the dialog is open, and it carries its own
 *    titled heading; it is not a continuation of the page's outline.
 */
function headingSequence(template: string, seen: ReadonlySet<string> = new Set(), steps = { n: 0 }): number[] {
  if (seen.has(template) || steps.n > MAX_WALK_STEPS) return [];

  steps.n++;

  const next = new Set(seen).add(template);
  const withoutDialogs = readTemplate(template).replace(/<hlm-dialog\b[\s\S]*?<\/hlm-dialog>/g, '');
  const levels: number[] = [];

  for (const match of withoutDialogs.matchAll(/<h([1-6])\b|<([a-z][a-z0-9-]*)\b/g)) {
    if (match[1]) levels.push(Number(match[1]));
    else if (match[2] && SELECTOR_TO_TEMPLATE.has(match[2])) {
      levels.push(...headingSequence(SELECTOR_TO_TEMPLATE.get(match[2]) as string, next, steps));
    }
  }

  return levels;
}

/** Every adjacent pair in a sequence that climbs more than one level. */
function outlineDefects(sequence: readonly number[]): string[] {
  const defects: string[] = [];

  for (let i = 1; i < sequence.length; i++) {
    const from = sequence[i - 1] as number;
    const to = sequence[i] as number;

    if (to > from + 1) defects.push(`h${from} → h${to}`);
  }

  return defects;
}

/** Every template transitively composed into `page`, the page itself included. */
function composedInto(page: string, acc = new Set<string>()): Set<string> {
  for (const tag of childSelectors(readTemplate(page))) {
    const child = SELECTOR_TO_TEMPLATE.get(tag);

    if (child && !acc.has(child)) {
      acc.add(child);
      composedInto(child, acc);
    }
  }

  acc.add(page);

  return acc;
}

// ── the derived sets under test ───────────────────────────────────────────────

const pages = pageRoutes(routes);
/** The templates the LEAF page routes render, in route order. A lazy route that
 *  also has `children` is a layout (AppShell) and renders no page of its own. */
const PAGE_TEMPLATES = lazy.flatMap((route, index) => (route.children?.length ? [] : [templateOfLazyRoute(index)]));
/** Every template that carries an `<h1>`, derived by scanning the tree. */
const H1_TEMPLATES = walk(APP, '.html')
  .map(APP_REL)
  .filter((rel) => /<h1\b/.test(readTemplate(rel)));
/** Every template a page can reach by composition. */
const REACHABLE = new Set(PAGE_TEMPLATES.flatMap((page) => [...composedInto(page)]));

describe('document structure (F20)', () => {
  describe('route titles', () => {
    it('finds the page routes (guards against a vacuous assertion)', () => {
      expect(pages.length).toBeGreaterThan(20);
    });

    it('gives every page route a title', () => {
      const missing = pages.filter(({ route }) => route.title === undefined).map(({ path }) => `path: '${path}'`);

      expect(missing.join('\n')).toBe('');
    });

    it('resolves every title against the en catalogue', () => {
      const unknown = pages
        .map(({ path, route }) => ({ path, title: route.title as string | undefined }))
        .filter((entry) => typeof entry.title === 'string')
        .filter((entry) => !hasKey(EN, entry.title as string))
        .map(({ path, title }) => `${path} → '${title}'`);

      expect(unknown.join('\n')).toBe('');
    });
  });

  describe('heading outline (N-9)', () => {
    it('derives a real multi-level outline for every page (anti-vacuity)', () => {
      // A walk that silently produced nothing would satisfy "no skipped level"
      // forever, so the derived sequences are asserted non-empty and genuinely
      // multi-level.
      const sequences = PAGE_TEMPLATES.map((rel) => headingSequence(rel));

      expect(sequences.filter((sequence) => sequence.length > 0).length).toBe(PAGE_TEMPLATES.length);
      expect(sequences.some((sequence) => sequence.length > 1)).toBe(true);
    });

    it('never climbs more than one heading level, following composition into child components', () => {
      const wrong = PAGE_TEMPLATES.flatMap((rel) => {
        const sequence = headingSequence(rel);

        return outlineDefects(sequence).map((defect) => `${rel}: [${sequence.join(', ')}] — ${defect}`);
      });

      expect(wrong.join('\n')).toBe('');
    });
  });

  describe('page headings', () => {
    it('derives a non-empty page set and a non-empty heading set (anti-vacuity)', () => {
      // A derivation that finds nothing is indistinguishable from a page set
      // that is trivially satisfied, so both sides are asserted non-empty and
      // the component index the composition walk depends on is asserted usable.
      expect(PAGE_TEMPLATES.length).toBeGreaterThan(20);
      expect(new Set(PAGE_TEMPLATES).size).toBe(PAGE_TEMPLATES.length);
      expect(H1_TEMPLATES.length).toBeGreaterThan(0);
      expect(SELECTOR_TO_TEMPLATE.size).toBeGreaterThan(20);
    });

    it('pairs every lazy route with exactly one import() in app.routes.ts', () => {
      // The positional pairing above is only sound while both sequences have the
      // same length. Without this, a route added without a matching import() —
      // or a stray import() elsewhere in the file — would shift every later
      // route onto the wrong component and quietly change what is asserted.
      expect(ROUTE_IMPORTS.length).toBe(lazy.length);
      expect(new Set(PAGE_TEMPLATES).size).toBe(PAGE_TEMPLATES.length);
    });

    it('gives every page exactly one h1, following composition into child components', () => {
      const wrong = PAGE_TEMPLATES.flatMap((rel) => {
        const rendered = headingCount(rel);

        return rendered === 1 ? [] : [`${rel}: ${rendered}`];
      });

      expect(wrong.join('\n')).toBe('');
    });

    it('reaches every h1 template from some page (no heading no user ever sees)', () => {
      // The other direction of the same correspondence: a heading that lives in
      // a component no routed page composes is asserted by the outline and
      // rendered by nobody. A NEW page is free — it is derived, not declared.
      assertDeclaredCoversDerived('h1 templates reachable from a routed page', [...REACHABLE], H1_TEMPLATES);
    });

    it('resolves each page template to a file that exists and is non-empty', () => {
      for (const rel of PAGE_TEMPLATES) {
        expect(readTemplate(rel).length, rel).toBeGreaterThan(0);
      }
    });
  });
});
