/**
 * Documentation guardrails for claims that DECIDE something.
 *
 * Two of the owner decisions in this batch are not code: one is a naming
 * decision and one is a decision about where a setting LIVES.
 * Both are the kind that decay silently — a paragraph gets reworded, a
 * `continue-on-error` gets added "just for this run", and the next reader is
 * back to guessing. Neither has a compiler, so this file is the compiler.
 *
 * The two things asserted here:
 *   • `AGENTS.md` names BOTH gates unambiguously, so "green locally"
 *     cannot be read as a claim about what ships.
 *   • C-11 — the `e2e` job carries no bypass marker, which is what makes its
 *     advisory status a HOSTING-SETTING fact rather than a workflow fact. This
 *     is a check of the current state, and a guardrail against the workflow
 *     silently acquiring a bypass the documentation would then misdescribe.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `server/src/testing` -> `server/` -> repo root. */
const ROOT = join(dirname(import.meta.filename), '..', '..', '..');
const AGENTS = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('N-13: the local gate and CI are named as two different things', () => {
  it('names both gates with names that cannot be confused', () => {
    // The decision was (c) — "keep both and NAME WHICH IS WHICH" — chosen over
    // (a) widen `check` and (b) a single sentence in passing, precisely because
    // the ambiguity has to be unmissable rather than merely noted.
    expect(AGENTS, 'AGENTS.md must give the local gate an explicit name').toContain('The LOCAL project gate');
    expect(AGENTS, 'AGENTS.md must give CI an explicit, different name').toContain('CI — THE REAL GATE');
  });

  it('states outright that green locally is not a claim about what ships', () => {
    // The sentence the whole item exists to make unmissable.
    expect(AGENTS).toMatch(/["'*_\s]*green locally["'*_\s]*is not a claim about what ships/i);
  });

  it('records what the local gate does NOT cover, so the gap is named not implied', () => {
    // A subset described only by what it includes reads as complete. The two
    // omissions that actually bite are the i18n gate and the server bundle
    // build — the artefact that ships.
    const section = AGENTS.slice(AGENTS.indexOf('The LOCAL project gate'));
    const localRow = section.slice(0, section.indexOf('\n', section.indexOf('server bundle build')));

    expect(localRow).toContain('check:i18n');
    expect(localRow).toContain('server bundle build');
  });

  it('still says the local script is deliberately a subset, and why', () => {
    // Widening `check` to match CI changes `package.json`, an owner-approval
    // boundary. That remains true after this decision, and a future editor
    // should meet the reason rather than rediscover the cost.
    expect(AGENTS).toMatch(/floor, not the ceiling/i);
    expect(AGENTS).toMatch(/owner-approval boundary/i);
  });
});

describe('C-11: the e2e job is not advisory BY ANYTHING IN THIS REPOSITORY', () => {
  it('the e2e job carries no continue-on-error marker', () => {
    // The verified fact behind item 22. The workflow file has exactly two
    // `continue-on-error` markers — the dependency audit and the formatting
    // check — and neither is in the e2e job. If someone adds one, the
    // documentation below becomes wrong and this fails first.
    //
    // The slice ends at the NEXT JOB, found by its own top-level key rather than by
    // a marker that only the first job can have. Ending at `\njobs:` instead made the
    // slice run to end-of-file whenever `e2e` was last, so a job added after it —
    // or a comment in one — decided this assertion's verdict for the e2e job.
    const jobStart = CI.indexOf('\n  e2e:');

    expect(jobStart, 'ci.yml must still declare the e2e job').toBeGreaterThan(-1);

    const afterKey = CI.slice(jobStart + '\n  e2e:'.length);
    // A job key sits at exactly two spaces; step and step-property keys are deeper,
    // so this cannot match one of those.
    const nextJob = afterKey.search(/\n {2}[A-Za-z][\w-]*:/);
    const e2eJob = nextJob === -1 ? afterKey : afterKey.slice(0, nextJob);

    expect(e2eJob, 'the e2e job must not carry continue-on-error').not.toContain('continue-on-error');
    // The slice really is the e2e job and not a prefix of the file: without this, a
    // `continue-on-error` in an earlier job would satisfy nothing above by accident
    // of slicing to the wrong place.
    expect(e2eJob, 'the slice must be the e2e job itself').toContain('Run Playwright e2e suite');
  });

  it('the rate-limit-integration job carries no bypass marker either', () => {
    // The same property, for the database-backed counter job: its entire value is
    // that the pipeline's atomicity is asserted against a real server, and a bypass
    // marker there would turn the one failure it exists to catch into a green run.
    const jobStart = CI.indexOf('\n  rate-limit-integration:');

    expect(jobStart, 'ci.yml must still declare the rate-limit-integration job').toBeGreaterThan(-1);

    const afterKey = CI.slice(jobStart + '\n  rate-limit-integration:'.length);
    const nextJob = afterKey.search(/\n {2}[A-Za-z][\w-]*:/);
    const job = nextJob === -1 ? afterKey : afterKey.slice(0, nextJob);

    expect(job, 'the job must not carry continue-on-error').not.toContain('continue-on-error');
    expect(job, 'the job must not carry a shell escape hatch').not.toMatch(/\|\| *true/);
    expect(job, 'the job must actually run the suite').toContain('npm run test:integration');
  });

  it('AGENTS.md says where the setting actually lives, not in these files', () => {
    // Item 22's deliverable: the owner must be told to change a
    // branch-protection rule on the hosting service. A note that only said
    // "advisory" would send the next reader into the YAML looking for a switch
    // that does not exist.
    expect(AGENTS).toMatch(/branch-protection rule on the hosting service/i);
  });
});
