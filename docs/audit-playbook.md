# Audit Playbook

A project-agnostic method for running a full **audit → prioritisation → refactor plan → guarded fixes → verification**
cycle over a codebase. It is written to be pasted into an agent's context as its brief. It assumes the agent has never
seen the repository it is auditing.

Three properties matter more than anything else in this document:

1. **Evidence over assertion.** Every claim in the output carries a command and an observation. An unverified claim is a
   liability, not a result.
2. **The guardrail is the deliverable.** A fix without a mechanism that makes its recurrence impossible is a patch with
   an expiry date.
3. **An audit reports violations of _applicable_ invariants, not preferences.** A popular pattern is not automatically
   correct, and a correct-looking pattern is not automatically an invariant. See section 0.5.

This playbook is a **baseline, not an eternal source of truth.** It was assembled against a specific stack and a specific
body of documentation; that material ages. Section 0.3 is mandatory and not optional.

---

## Table of contents

- [Audit Playbook](#audit-playbook)
  - [Table of contents](#table-of-contents)
  - [0. How to use this playbook](#0-how-to-use-this-playbook)
    - [0.1 When to run it](#01-when-to-run-it)
    - [0.2 Phase 0 — read the repository first](#02-phase-0--read-the-repository-first)
    - [0.3 Re-research the stack before you audit it](#03-re-research-the-stack-before-you-audit-it)
    - [0.4 Subordination to the repository's own rules](#04-subordination-to-the-repositorys-own-rules)
    - [0.5 What an audit reports](#05-what-an-audit-reports)
      - [Obligation levels](#obligation-levels)
    - [0.6 Vocabulary](#06-vocabulary)
    - [0.7 Distinguish these before you write a finding](#07-distinguish-these-before-you-write-a-finding)
    - [0.8 Scoping a run](#08-scoping-a-run)
    - [0.9 Sequencing tracks](#09-sequencing-tracks)
    - [0.10 The chain every phase follows](#010-the-chain-every-phase-follows)
  - [1. Execution discipline](#1-execution-discipline)
    - [1.1 Time caps](#11-time-caps)
    - [1.2 Never delete accurate content to satisfy a metric](#12-never-delete-accurate-content-to-satisfy-a-metric)
    - [1.3 Evidence, not assertion](#13-evidence-not-assertion)
    - [1.4 Artefacts go to the designated scratch location](#14-artefacts-go-to-the-designated-scratch-location)
    - [1.5 Record repository state before any bulk operation](#15-record-repository-state-before-any-bulk-operation)
    - [1.6 One owner per file](#16-one-owner-per-file)
    - [1.7 Check for a previous interrupted attempt](#17-check-for-a-previous-interrupted-attempt)
    - [1.8 Command hygiene](#18-command-hygiene)
  - [2. Phase 1 — Audit (read-only)](#2-phase-1--audit-read-only)
    - [2.0 Track template and reporting rules](#20-track-template-and-reporting-rules)
      - [2.0.1 The observation filter](#201-the-observation-filter)
      - [2.0.2 Three standing clauses](#202-three-standing-clauses)
      - [2.0.3 Enforcing artefact and failure latency](#203-enforcing-artefact-and-failure-latency)
      - [2.0.4 Reachability, exploit scenario, impact](#204-reachability-exploit-scenario-impact)
    - [2.1 Architecture and layering](#21-architecture-and-layering)
    - [2.2 Frontend framework](#22-frontend-framework)
      - [Establish the declared reactivity model first](#establish-the-declared-reactivity-model-first)
      - [2.2.1 The client-side form layer](#221-the-client-side-form-layer)
    - [2.3 UI library and design system](#23-ui-library-and-design-system)
      - [Inventory the artefacts before asking about styles](#inventory-the-artefacts-before-asking-about-styles)
      - [2.3.1 Localization and the translation catalogue](#231-localization-and-the-translation-catalogue)
      - [2.3.2 Rich-text surfaces](#232-rich-text-surfaces)
    - [2.4 Types and domain model](#24-types-and-domain-model)
    - [2.5 Backend HTTP and platform](#25-backend-http-and-platform)
      - [Establish the topology first](#establish-the-topology-first)
    - [2.6 Database and data model](#26-database-and-data-model)
      - [The audit unit for scoping is the query, not the route](#the-audit-unit-for-scoping-is-the-query-not-the-route)
      - [Name the actor that executes a data lifecycle](#name-the-actor-that-executes-a-data-lifecycle)
    - [2.7 Input validation](#27-input-validation)
    - [2.8 Security](#28-security)
    - [2.9 Performance](#29-performance)
      - [Use the platform's published numbers, and say where each came from](#use-the-platforms-published-numbers-and-say-where-each-came-from)
    - [2.10 Bundle size](#210-bundle-size)
    - [2.11 Code quality](#211-code-quality)
    - [2.12 Error handling](#212-error-handling)
    - [2.13 Observability](#213-observability)
    - [2.14 Testing](#214-testing)
      - [Audit what the test runner does not execute](#audit-what-the-test-runner-does-not-execute)
    - [2.15 API design](#215-api-design)
    - [2.16 Styling and UI consistency](#216-styling-and-ui-consistency)
    - [2.17 Accessibility](#217-accessibility)
      - [Anchor the version, and split automated from manual](#anchor-the-version-and-split-automated-from-manual)
    - [2.18 Configuration and environments](#218-configuration-and-environments)
    - [2.19 Dependencies](#219-dependencies)
      - [Three decisions, not one](#three-decisions-not-one)
    - [2.20 Git and repository hygiene](#220-git-and-repository-hygiene)
    - [2.21 CI/CD and developer experience](#221-cicd-and-developer-experience)
    - [2.22 Finding format](#222-finding-format)
    - [2.23 The refuted log](#223-the-refuted-log)
    - [2.24 The cross-stack seam pass](#224-the-cross-stack-seam-pass)
      - [The corrections that survive](#the-corrections-that-survive)
      - [The seams to walk](#the-seams-to-walk)
      - [The method, per seam](#the-method-per-seam)
      - [The deliverable](#the-deliverable)
  - [3. Phase 2 — Prioritisation](#3-phase-2--prioritisation)
    - [3.1 Deduplicate](#31-deduplicate)
    - [3.2 Score each defect](#32-score-each-defect)
    - [3.3 Assign a bucket — and write the rule down](#33-assign-a-bucket--and-write-the-rule-down)
    - [3.4 Classify the fix type](#34-classify-the-fix-type)
    - [3.5 Root-cause analysis](#35-root-cause-analysis)
    - [3.6 Resolve contradictions between tracks](#36-resolve-contradictions-between-tracks)
    - [3.7 Compile the owner questions](#37-compile-the-owner-questions)
  - [4. Phase 3 — Refactor plan](#4-phase-3--refactor-plan)
    - [4.1 Waves](#41-waves)
    - [4.2 Dependency graph](#42-dependency-graph)
    - [4.3 Work package template](#43-work-package-template)
    - [4.4 Rules for the plan](#44-rules-for-the-plan)
    - [4.5 Definition of done per wave](#45-definition-of-done-per-wave)
    - [4.6 Quick wins](#46-quick-wins)
    - [4.7 Do-not-do list](#47-do-not-do-list)
    - [4.8 Deferred pending owner answers](#48-deferred-pending-owner-answers)
  - [5. Phase 4 — Fixes](#5-phase-4--fixes)
    - [5.1 The guardrail forms](#51-the-guardrail-forms)
    - [5.2 Proving a guardrail fails](#52-proving-a-guardrail-fails)
    - [5.3 Order of work](#53-order-of-work)
    - [5.4 Behaviour changes](#54-behaviour-changes)
    - [5.5 Subtask brief skeleton](#55-subtask-brief-skeleton)
    - [5.6 Dispatch rules](#56-dispatch-rules)
    - [5.7 When to stop and ask](#57-when-to-stop-and-ask)
  - [6. Phase 5 — Verification and report](#6-phase-5--verification-and-report)
    - [6.1 Clean-state verification](#61-clean-state-verification)
    - [6.2 Results table](#62-results-table)
    - [6.3 Before/after deltas](#63-beforeafter-deltas)
    - [6.4 Mess check](#64-mess-check)
    - [6.5 The owner-facing report](#65-the-owner-facing-report)
  - [7. Typical traps](#7-typical-traps)
  - [Appendix — a one-page checklist for a run](#appendix--a-one-page-checklist-for-a-run)

---

## 0. How to use this playbook

Read sections 0 and 1 in full before touching the repository. Sections 2–6 are executed in order; section 7 is a review
list, not a step.

### 0.1 When to run it

Run the full cycle when one or more of these is true:

- **Periodically** — on a fixed cadence, so drift is bounded rather than discovered during an incident.
- **Before a release** — the window where a regression is cheapest.
- **After a dependency or platform migration** — the moment when generated code, upgrade notes and old assumptions are
  most likely to have been applied inconsistently.
- **After an incident** — an incident is a proven defect; the audit is how you find the other instances of the same
  shape before they fire.
- **After a large refactor** — to prove the refactor did not move a boundary without meaning to.
- **Before onboarding a new maintainer** — the output is often the shortest honest description of the system.

### 0.2 Phase 0 — read the repository first

Do not begin any track until you can answer all of the following from the repository itself, not from assumption. Check
whether this repo declares each of these; when it does, the declaration is binding for the whole run.

- [ ] **Entry-point instructions.** Does the repository designate an agent/contributor entry document (a root-level file
      the project treats as the router for tooling)? If yes, read it completely and list every MUST and MUST NOT it
      contains. If no, say so in the run report — the absence is itself a finding.
- [ ] **Architecture documentation.** Does one exist? Which sections cover layering, the request lifecycle, dependency
      injection, authorisation, the data model, and the design decisions with their rationale?
- [ ] **The real commands.** How does this project install, build, lint, typecheck, test, and run? Record the exact
      invocations, the working directory each needs, and which of them are the _canonical gate_ (the one command the
      project itself designates as the definition of green).
- [ ] **What "green" means.** Which checks are blocking, which are advisory, which are reported-but-not-failing? A lint
      warning budget, a coverage floor, a size budget, a pass rate that is tolerated rather than enforced.
- [ ] **Hard rules the project declares for itself.** Naming, layering, error-envelope shape, response format, DI style,
      state-management style, test conventions, forbidden patterns. Each becomes a hard constraint on Phase 4: a "fix"
      that violates a declared rule is not a fix, it is a relocation of the problem.
- [ ] **Scratch location.** Where does this project want throwaway analysis, probes and one-off scripts? Check the
      ignore configuration and any declared convention. If none is declared, pick one location outside the source tree,
      add it to the project's ignore configuration as a separate, clearly-labelled change, and state that you did. Never
      leave a scratch file at the repository root or beside source: it is parsed by lint and format tools, and it slows
      every future run.
- [ ] **Boundaries.** What requires asking first (dependency installation, lockfile edits, schema changes, destructive
      data operations) and what must never be done automatically (production deploys, history rewrites, force pushes)?
- [ ] **Guardrail tests.** Does the repository already contain tests that exist specifically to fail when a project rule
      is broken? These are the project's own invariants, and they tell you what the maintainers already care about.
      Reuse their shape in Phase 4 rather than inventing a new mechanism.
- [ ] **Test and tooling conventions.** Read the test setup and any documented testing notes. Framework test runtimes
      impose rules (change-detection calls, timer installation order, selector rules, async settling) that make a
      "correct" test flaky or falsely green.
- [ ] **Baseline.** Run the canonical gate once, unmodified, and record the result. A pre-existing failure is a fact of
      the run's starting state, not something you caused and not something to hide.

Record the answers as a short orientation note in scratch. Everything downstream references it.

### 0.3 Re-research the stack before you audit it

**This playbook encodes knowledge that was true of a specific stack at a specific moment. A previous agent's research is
a starting point, never a citation.** Before a significant audit, re-check the stack actually in scope.

- [ ] **Write down the stack in scope**, from the manifests and the lockfile, not from the entry document: language
      version, framework and its major, each direct dependency and its resolved version, the platform/runtime, the
      database engine and server version, the build tool, the test runner, the CI actions.
- [ ] **Re-read the current official material** for each area the run will touch: the framework's security guide and
      migration guide; the release notes for every major since the pinned version; the validation library's own
      migration guide and recent changelog entries labelled as breaking or as soundness fixes; the platform's limits
      and lifecycle pages; the specification each accessibility and observability claim rests on.
- [ ] **Check the advisories and migration notes** for the direct dependencies in the security or correctness path.
- [ ] **Re-derive, do not recall.** Any statement in this playbook that is version-sensitive ends with a `Freshness`
      line naming what to revalidate and the trigger. Follow those lines. A version number written into an audit rule is
      a rule that will be wrong; what belongs in the playbook is the *question* and the *source* to re-read.
- [ ] **Record what you revalidated, in the report** — one line per area: what was re-read, against which source, and
      whether the playbook's statement still held, was superseded, or was not applicable here. A run that skipped this
      must say so, because then every technology claim in its report is inherited rather than verified.
- [ ] **Prefer the shipped source over the documentation** for any mechanism claim about a pinned dependency. The
      library's docs and its shipped code disagree more often than anyone expects, and the code is what runs.
- [ ] **Note what you could not revalidate** (no access, no time, private documentation) as *not verified*, and treat
      every check that depended on it as inherited.

The failure mode this step exists to prevent: a confident, well-formatted report that is wrong because the knowledge is
two major versions old, and whose every sentence is traceable to a document that said so confidently when it was
written.

### 0.4 Subordination to the repository's own rules

This playbook is a method, not a standard. It never overrides a rule the project declares for itself.

- When the repository's documented rule and this playbook's preference conflict, **the repository wins**. Note the
  conflict in the report; do not silently follow the playbook.
- When the repository has no rule, this playbook's default applies.
- When following a repository rule produces an implementation you believe is wrong, the correct move is to report the
  tension with evidence and let the owner decide — not to fix it and mention it afterwards.

### 0.5 What an audit reports

An audit identifies violations of **applicable invariants**. A personal preference is not a finding, however strongly
held, however often repeated, or however common the pattern is in the ecosystem. Equally, a well-liked pattern can be
a defect: popularity is a measure of adoption, not of correctness.

- [ ] Every finding states the **invariant it violates** and where that invariant comes from: a specification, a
      security advisory, the platform's documented guarantee, a design decision the project itself declared, or an
      internal consistency law. "This is bad practice" is not a source.
- [ ] Where the project has declared the rule, the declaration is the invariant. Where it has not, say whether the
      finding is a correctness/security/cost defect (report it) or a consistency/style preference (demote it to a note,
      or drop it).
- [ ] Do not manufacture invariants to justify a finding you already wanted to write.
- [ ] Where a check's answer depends on a project fact you have not established, establish the fact first (section 0.2,
      0.3, 2.24) rather than reporting the outcome you assumed.

#### Obligation levels

Every check in this playbook that carries a status uses one of four levels, and the level is the obligation, not a
severity:

| Status             | Meaning                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MUST`             | Violating it is a defect, or a security/correctness hole, independent of project context.                                                                                |
| `SHOULD`           | The wrong choice is a defect in almost every codebase, but a documented, deliberate exception is legitimate. Record the exception rather than converting it into a rule.  |
| `MAY`              | A judgement call. The check exists to make the choice explicit and recorded, not to make it for you.                                                                    |
| `CONTEXT-DEPENDENT` | The correct answer depends on a stated project fact. The check's job is to determine the fact first, then answer. A finding recorded before the fact is established is a guess. |

A `CONTEXT-DEPENDENT` check whose precondition is **absent** does not become a checklist item. It becomes a *trigger*
attached to a check that does apply — "this becomes relevant the day the project enables server rendering / accepts a
file upload / authenticates with a cookie" — or it is dropped. A rule that cannot fire teaches auditors to skip the
list.

The status is per **check**, not per track, and not per defect. It must not be confused with the prioritisation buckets
in section 3.3: `MUST` is a statement about correctness, **Must** is a statement about this run's priorities.

### 0.6 Vocabulary

Use these words consistently in every artefact; ambiguous vocabulary is how a refactor plan becomes an argument.

- **Finding** — a candidate defect produced by a track. Has an id, evidence, and a confidence.
- **Defect** — a deduplicated, confirmed finding. One root cause, one fix direction, one work package.
- **Guardrail** — a mechanism that makes a defect class impossible or fails the build when it recurs.
- **Hotfix** — a fix that changes behaviour but not structure.
- **Structural fix** — a change to a boundary, seam, or data flow.
- **Preventive fix** — a guardrail.
- **Deletion** — removing the defect by removing the code. Always a candidate; rarely chosen for reasons stated below.
- **Refuted claim** — a hypothesis that was tested and did not hold. Logged, not deleted.
- **Open question** — a decision only the owner can make. Blocks the work that depends on it.
- **Seam** — the place where two independently correct halves meet and hand data to each other. Defects live at seams
  because each half is audited against its own rules and neither half is audited against the other's assumptions
  (section 2.24).
- **Silent degradation** — a mechanism that stops working without raising an error: a notification that never fires, a
  guard that no-ops, a check that is skipped, a result that is discarded, a value that reads as valid. The defect class
  that no stack trace finds.

### 0.7 Distinguish these before you write a finding

Almost every bad audit report — and most bad fixes — comes from confusing one of these pairs. The pairs are cheap to
check and expensive to get wrong. Run the failing column's test before writing the finding, not after.

The first thirteen pairs are about **defects**: two things that are not the same kind of thing. The last four are about
**defaults** — a behaviour nobody chose, which is still the behaviour in production, and which is the part of a system
an auditor reads least. A finding that traces to a default must name the default, the source that documents it, and
the version it was observed in.

| Distinguish                                            | Because                                                                                                                             | The test that separates them                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Symptom vs root cause                                 | A patched symptom recurs; a fixed cause does not.                                                                                   | Ask which seam, if changed once, would prevent the whole class. If you cannot name it, you have a symptom (see 3.5). |
| Theoretical vs reachable vulnerability                 | An unreachable vulnerability is a note, and reporting it as critical destroys the report's credibility.                                     | Name the entry point (method, path, parameter) and the caller's privilege. Cannot name both ⇒ not a finding.  |
| Smell vs defect                                       | A smell predicts future defects; it is not one.                                                                                      | Name the input that makes it fail. If none exists, it is a smell — report it as a cost, not a defect.           |
| Optimisation opportunity vs measured bottleneck        | Optimising an unmeasured path spends risk for nothing.                                                                              | A profile, a trace, or a counter — with the input and the error. Without one, it is an opportunity.            |
| Framework convention vs application invariant           | Breaking a convention is cosmetic; breaking an invariant is a defect.                                                                 | Is the convention stated in the framework's own guidance (then convention), or does this system's correctness depend on it (then invariant)? |
| Compile-time safety vs runtime safety                  | A required parameter prevents the call; it does not check the value.                                                                 | Say which half the mechanism gives you. A type that cannot be wrong and a value that is merely unvalidated are different artefacts. |
| Coverage vs behavioural coverage                        | A covered line can assert nothing.                                                                                                 | For each critical path, name the assertion that would fail if the behaviour broke — not the line, the claim.  |
| Green build vs correct application                     | A gate covers the checks someone wrote.                                                                                             | Read what the gate actually runs; a gate that omits a package you touched is silent about it.                 |
| Passing test vs meaningful assertion                   | A test that cannot fail is worse than no test, because it is trusted.                                                                | Temporarily break the behaviour and observe it go red (see 5.2).                                             |
| Mechanism present vs mechanism executed                 | An index, a cron config, a purge function and a rate-limit counter can all exist while the lifecycle never runs.                      | Name the **actor** that executes it, and when it last ran. Mechanism present is not mechanism working.       |
| Configured value vs deployed value                      | The environment where the defect fires is the one that is deployed.                                                                 | Read the deploy command, not the config comment; reconcile every prose statement of the default against it.  |
| Code correctness vs knowledge currency                  | Correct code with stale knowledge produces a confident, wrong report.                                                                | Re-read the current source for this dependency (0.3). Anything not revalidated is inherited, and must say so. |
| Absent vs not verified                                 | "Clean" and "I did not look" are different claims and are read identically.                                                         | If you lacked the time, access or environment, the cell says **not verified**. Never **clean**.          |
| Absent mechanism vs absent defect                      | The presence of a control is evidence; its absence is not evidence that anything is wrong with the code that lacks it.                     | Name the control the code is supposed to have and where it is mounted. Nothing is mounted ⇒ the finding is about an **absence**, which no scan for the bad thing can produce. |
| Default vs explicit                                    | A behaviour nobody chose is still the behaviour, and it is the one that ships.                                                       | For any bound, fallback, coercion or timeout: is the value written in the code, or inherited? Write down which, and the source of the default. |
| One ordering vs two                                    | Two halves that are each correct can disagree about what "equal" and "in order" mean.                                                 | Name the comparison each side performs on the same value. Where they differ, every property built on the comparison — uniqueness, dedupe, pagination, search — is only as strong as the weaker half. |
| One clock vs two                                       | An expiry or a limit compared against the wrong clock is not a defect at the boundary; it is a defect in the arithmetic.                     | Name the clock each side reads and the tolerance the comparison applies. A specification that permits a leeway does not make the code apply one. |

### 0.8 Scoping a run

Decide the scope before reading code, and write the decision down.

- **Full sweep** — every track. Use it for the first audit of a repository, before a release, or after an incident.
  Budget it as several sessions; do not compress it into one pass.
- **Selected tracks** — pick by trigger. A design-system migration justifies the design-system, bundle, styling and
  accessibility tracks. A latency complaint justifies the performance, database, backend and frontend tracks. A security
  review justifies the security track plus the reachability parts of the backend, database and validation tracks, and
  the seam pass.
- **Single-question run** — one question, the minimum set of tracks that can answer it, and a written statement of what
  the run will _not_ conclude. This is the right shape for a cheap, focused pass.
- **Depth per track** — declare per track: _inventory only_ (list what exists), _analyse_ (judge it), or _measure_ (run
  something to produce a number). Measuring is the most expensive and is the first thing to cut when a decision does not
  depend on the number.

Scope out loud: the tracks in, the tracks out, the seam pass in or out, and the reason for each exclusion. An unstated
exclusion becomes a "no findings" claim later.

### 0.9 Sequencing tracks

Order tracks so that each one's findings sharpen the next, and so that expensive measurement is not wasted.

1. **Orientation and vocabulary** — Phase 0, plus the re-research step, plus a fast architecture pass. Without the
   layering map, every later track produces findings you cannot classify.
2. **Contract surfaces** — the API-design, validation, types and database tracks. These define what the system promises;
   they are read-mostly and cheap.
3. **Trust and safety** — the security, backend, error-handling and observability tracks. Cross-reference security
   against backend/database/validation so reachability is judged against the real call graph rather than in isolation.
4. **Behaviour and cost** — the frontend, performance, bundle, testing, styling and accessibility tracks. These benefit
   from knowing the contracts and the risks.
5. **Surroundings** — the code-quality, configuration, dependencies, repository-hygiene and pipeline tracks. Last
   because they are least likely to be invalidated by earlier findings and most likely to need the whole picture.
6. **The seam pass** — section 2.24, after every track has run, because its whole input is what the tracks found
   individually.

Overlap is expected and useful: a type/domain defect found in the types track usually explains an error-handling
finding. Record cross-references rather than resolving them inside a single track.

### 0.10 The chain every phase follows

The phases are organised by topic; the work is organised by this chain, and every check in section 2 is one link of
it. An audit that skips a link produces a report that reads like a result and is not one.

| Link           | What it produces                                                                  | Where the rule lives                             |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| Observe        | The fact, with the tool that produced it and the input it was given               | 1.3, 2.0.1                                       |
| Hypothesise    | The defect you suspect, written **before** you look for it                        | 2.23 — a wrong one becomes a refuted-log entry  |
| Verify         | The command run, its exit code, the input, and how it was repeated                | 1.3, 2.0.1                                       |
| Evidence       | The quoted line, the captured response, the plan, the profile, the counter        | 2.22 — `evidence:` is mandatory                  |
| Impact         | What it costs **in this deployment**, not what it costs in general                | 0.5, 2.0.4                                       |
| Root cause     | The seam whose single change removes the class                                    | 3.5                                              |
| Guardrail      | The mechanism, its tier, and the proof that it fails when the defect returns       | 2.0.3, 5.1, 5.2                                  |
| Fix            | The work package, with its file boundary, its rollback and its behaviour changes  | 4.3, 5.4, 5.5                                    |
| Verify again   | The same gate and the same measurement, before and after                          | 6.1, 6.3                                         |

Two links keep the chain from degrading into a list of ticks, and they are the first two and the fifth. **Hypothesise**
is what makes 2.23 possible at all: a hypothesis written down first is either confirmed, and becomes a finding, or it
fails, and becomes a refuted-log entry — so a wrong turn produces output instead of disappearing. **Impact** is what
separates a defect from a preference: an impact that cannot be stated in this deployment is a note, however bad the
code looks. Drop either link and the remaining ones still produce a document, and it will be wrong in a way no
reviewer can see.

---

## 1. Execution discipline

These rules exist to keep a run cheap, honest, and reversible. Each has a one-line reason.

### 1.1 Time caps

- [ ] **Every command has an explicit time cap.** No cap means the run stalls on a watch process, an interactive prompt,
      or a network wait. Set a cap for anything that is not provably finite.
- [ ] **Do not run a measurement unless a decision depends on it.** An unused number is pure cost; it also creates
      pressure to act on it.
- [ ] **Never re-measure an established fact to "be sure".** If a fact is established, cite it. Re-running a gate
      because the previous result feels uncomfortable is the most common way a run burns an hour and learns nothing.
- [ ] **If something appears to hang, kill it and report it.** Do not keep waiting. "The command did not terminate
      within the cap" is a legitimate result and frequently a finding in its own right.

### 1.2 Never delete accurate content to satisfy a metric

- [ ] **A guardrail complaining does not mean the code is wrong.** Decide which of the two it is, and say which: - _The
      guardrail is wrong_ — then change it deliberately, with a stated reason, in its own change, never smuggled inside
      a feature commit. - _The code is wrong_ — then fix the code.
- [ ] **Size ratchets, lint ceilings, coverage thresholds, test-count literals, bundle budgets:** when one fires, do not
      lower the number, do not add a suppression, and do not delete a file to make the count pass.
- [ ] **Do not weaken an assertion to force green.** Deleting a check because it fails is the single most damaging
      action available to an agent, because it destroys the evidence that the defect existed.
- [ ] **Exhaust the real options first:** the measurement may itself be wrong (a miscounting tool, a stale cache, a
      wrong scope), the ceiling may encode an outdated assumption, or the content may genuinely be dead — and "dead" is
      a claim requiring proof, not an impression.

### 1.3 Evidence, not assertion

- [ ] Every "fixed", "green", "passed", "faster" carries a command and an exit code.
- [ ] Every quantity carries how it was measured, on what input, and the error it carries.
- [ ] A subtask that cannot verify something says so explicitly, in those words, rather than implying success by
      omission.
- [ ] Quote the evidence. A finding that cites one line of code and one command survives review; a finding that cites a
      vibe does not.
- [ ] Separate _observed_ (measured, read, executed) from _inferred_ (deduced from a pattern). Never let inference be
      reported in the observed column.

### 1.4 Artefacts go to the designated scratch location

- [ ] Every generated artefact — probe scripts, analysis output, query dumps, snapshots, before/after listings — goes in
      the project's designated scratch directory.
- [ ] **Never** at the repository root, never beside the source it describes, never in a tracked configuration
      directory. Scratch files at those locations are parsed by lint and formatting tools, which turns a five-second
      task into a multi-minute one for everyone afterwards.
- [ ] **Durable documentation must never point at a scratch file.** Scratch is disposable and gets deleted; a link from
      permanent documentation to a deleted file is a lie that survives longer than the run. If a finding's evidence is
      worth keeping, the finding belongs in the audit report, not in a scratch file.
- [ ] If the scratch directory is not ignored, fix that first, in isolation, before generating anything into it.
- [ ] Delete scratch when the run ends. Leaving it costs nothing in git but costs confusion in the next run.

### 1.5 Record repository state before any bulk operation

- [ ] Before anything that touches the working tree in bulk — pulling with uncommitted work, merging, rebasing,
      switching branches, applying a wide rename — **snapshot the state first**: the full diff, the list of untracked
      files, and a count plus hash per file for the files the operation could touch.
- [ ] **Never run destructive git commands.** No `reset --hard`, no `clean`, no forced checkout that discards local
      modifications, no history rewrite, no force push. If the working tree must be reset, that is the owner's decision,
      made deliberately, with a stash or a branch they created themselves.
- [ ] **Prove afterwards that nothing was lost:** compare counts and hashes before and after. "It looked fine" is not a
      proof; a diff of two `sha256sum` listings is.
- [ ] If the snapshot and the post-operation state disagree, stop everything and report it before doing anything else.

### 1.6 One owner per file

- [ ] No two parallel subtasks may edit the same files. Assign file ownership explicitly in every subtask brief.
- [ ] A subtask that finds something outside its boundary **does not fix it**. It records it and hands it back to the
      orchestrator as a task. Cross-cutting findings are the orchestrator's to schedule, because two owners is how a
      merge conflict becomes a silent behaviour change.
- [ ] Shared infrastructure (composition roots, shared types, index/entry files, configuration) is owned by the
      orchestrator for the whole run unless explicitly delegated as a single unit.
- [ ] Sequentialise anything that would touch the same file even indirectly through generated output.

### 1.7 Check for a previous interrupted attempt

- [ ] Before starting, establish whether a previous run was cancelled: an unmerged branch, an untracked file set that
      does not match the source tree, a half-applied migration, a partially rewritten module, a dangling temporary file,
      a test that references a symbol that no longer exists.
- [ ] If half-applied edits exist: review them, decide keep-or-revert per file, and continue from there. Do not start a
      competing rewrite of the same area.
- [ ] Re-establish the baseline gate result before continuing. A cancelled run may have left the gate red for reasons
      unrelated to your work, and you must not inherit it as your own output.

### 1.8 Command hygiene

- [ ] Check the project's declared command forms before improvising; use what the project documents.
- [ ] Never install dependencies, change a package manifest, or touch a lockfile during an audit track. If a measurement
      requires it, it is a question for the owner, not a decision for the agent.
- [ ] Never print secret values. Search for secret _names_ to prove absence; never echo the contents of an environment
      file, a credentials store, or a signing key.
- [ ] Prefer read-only inspection commands over ones that mutate caches, lockfiles, or generated output in ways the
      project does not already regenerate. If a command does mutate generated output, say so and plan to restore.
- [ ] Run each measurement once, from a clean state, with the scope you intend to report. A number from a warm
      incremental cache is not a number.

---

## 2. Phase 1 — Audit (read-only)

### 2.0 Track template and reporting rules

Each track below has the same five parts: **Goal**, **Read**, **Measure**, **Deliverable**, **Must not conclude without
evidence**. Follow them in that order. The read list defines the minimum surface; the measure list defines what may be
turned into a number, and each measurement carries a cost you should pay only once.

Tracks that carry technology-specific knowledge add a fourth element: **Deep checks**. A deep check is written in a
fixed shape — **Question / Why / Look for / Evidence / Failure modes / Verification / Sources / Freshness** — and it
carries an obligation status (section 0.5). Deep checks are the part of the playbook that goes stale, which is why each
one ends with a `Freshness` line naming what to revalidate and the trigger, and why none of them states a version number
as the rule. If a deep check cannot be applied to the project in scope, apply the applicability rule in 0.5: it becomes
a trigger or it is dropped.

Global rules for the whole audit phase:

- [ ] **Change nothing.** No source edits, no formatting runs, no "while I was there" fixes, no dependency changes, no
      config edits. An audit that fixes things has no audit.
- [ ] **All artefacts to the designated scratch location**, named so a stranger can tell what produced them.
- [ ] **Every finding carries evidence.** No evidence, no finding.
- [ ] **Inventing findings is forbidden.** If you did not read the code, run the query, or execute the command, the
      finding does not exist. A plausible-sounding defect you have not verified is worse than an empty report, because
      it will be "fixed".
- [ ] **Distinguish "absent" from "not found".** If you did not have the time, the access, or the environment to check
      something, record it as **not verified** — never as **clean**.
- [ ] Cap every command. If a command exceeds its cap, kill it and record the timeout as the result.
- [ ] Prefer the repository's own tooling for any measurement it already declares (its linter, its type checker, its
      test runner, its bundle analyser, its security audit tool). A bespoke measurement disagrees with the project's
      gate and creates work for no one.

#### 2.0.1 The observation filter

Acceptance test for **every** item in this playbook, in every track. Ask: **what tool or action observes this, on what
input, and what result counts as failure?**

- An item that answers is a check. An item that does not is a paragraph, and a paragraph produces no findings.
- Name the **evidence type**, because the types are not interchangeable: a *profile*, a *trace*, a *computed ratio*, a
  *plan*, a *command's exit code*, a *rendered page*, a *table*. "Check performance" names none of them.
- Where the project has published a **threshold**, comparison is the check. Where it has not, the missing threshold is
  itself a finding, with a trigger — not a licence to invent a number and present it as a rule.
- Where a check cannot be decided from the repository, say what external input it needs and who must supply it. An
  undecidable check is an open question (3.7), not a shrug.
- Before adding a new checklist item, apply the second filter: **which existing check does the defect it would catch
  pass?** If several do, the item is a material change to one of them and belongs there. If none does, it is a new track
  item and needs its own evidence type.
- **Give the check a predicate, or do not write it.** A predicate is a named input plus a named failing result — "a
  `find` and a `sort` on one query that disagree about `ä`" fails; "the sorting is wrong" is a paragraph. A check with
  no predicate has a second cost, and it is the more expensive one: **a check that fires on correct code is worse than
  a missing check.** It burns a review cycle, it teaches the reader that this section is noisy, and the real finding
  two lines below it is the one that gets skipped.
- **Decide whether the check is a statement about the value or about the input, before you write it.** A rule phrased
  about a value misfires on code that is correct by design — a connection cached in a scope whose lifetime contains it
  is not a leak, and a tolerance for clock skew is not a second way to keep time. A rule phrased about the input — *a
  cached value outlives the request it belongs to*, *two clocks are compared with no tolerance* — fires only on the
  defect. Where a check has produced a false positive before, this is usually why, and the fix is almost always to
  change what the sentence is about rather than to add an exception to it.

#### 2.0.2 Three standing clauses

Three clauses apply to every track. They are the generalisations that came out of auditing the same code twice.

**1. Silent degradation — prove the mechanism still fires.** The dominant defect class in a modern stack is not a crash;
it is a mechanism that stops working without raising an error: a notification that no longer fires, a guard that
no-ops, a claim the library skips when it is absent, a response body that says success while the work failed, a
lifecycle that is modelled and never executed. None of these produce a stack trace, and a screenshot shows all of them
as fine.

- [ ] For every mechanism the code depends on, the evidence is a **behavioural** observation: the state attribute is
      present, the notification arrived, the guard denied, the error surfaced. Not the presence of the call.
- [ ] State the property in terms of something observable — "the state attribute is present", "the value updates
      without a manual trigger" — never in terms of "it looks right".
- [ ] Ask of each mechanism: **what is its absent-input path, and is that path tested?** A guard that no-ops when its
      input is missing is fail-open, and no ordinary test exercises that path, because the caller usually prevents it.

**2. Pinned dependency — verify the mechanism, and list the semantics you rely on.** Two different questions, both
required, both invisible to grep:

- [ ] **Verify the mechanism against the shipped source**, not the documentation and not memory. Read the installed
      package. A wrong mechanism explanation produces a correct mitigation justified by a false claim, and the next
      maintainer "corrects" it back.
- [ ] **List the library behaviours the code depends on that a minor release may change** — defaults, the unit of a
      length bound, whether unknown keys are stripped or allowed, whether a claim the library verifies is skipped when
      absent, whether a failure is an exception or a value. Defaults are the contract on a validation boundary, and
      defaults are what a version bump changes. The deliverable is a list, and it is the highest-value artefact a
      boundary audit produces.

**3. Applicability — a rule whose precondition is absent becomes a trigger.** If the project does not do the thing —
server rendering, file upload, cookie sessions, a shell, a second client population, an external API consumer — the
context-dependent check does not become a checklist item. Record the negative **with the condition that would falsify
it**, and attach it to a check that does apply. Carrying unfireable rules teaches auditors to skip the list, which
costs more than the rules were worth.

#### 2.0.3 Enforcing artefact and failure latency

Every invariant the project claims — a rule in its entry document, a rule in a comment, the name of a test — has an
**enforcing artefact**. Name it, or the claim is unverified. Four tiers, in descending strength:

| Tier        | Form                                                                                                     | Failure latency |
| ----------- | -------------------------------------------------------------------------------------------------------- | --------------- |
| Type-level  | The unsafe call is unrepresentable: a required parameter, a closed type, a validated configuration object.    | **Build**       |
| Table-level | A test enumerates a structure (the route table, the declaration set, the page list) and asserts every row. | **CI**          |
| Behavioural | A test asserts the behaviour, and it is proven to fail when the behaviour is broken.                       | **CI**          |
| Convention  | "Do not do this." Prose, a review comment, a comment in the code.                                         | **Never**       |

- [ ] For each claimed invariant, record the artefact and the tier. A claim whose only artefact is prose is the last
      tier: report it as unverified, with the consequence that it decays at the first deadline.
- [ ] Prefer the strongest available tier. Moving a claim from prose to a test is a defect fix in its own right.
- [ ] Two-way guardrails are the strongest form of the table-level tier and cost little: assert that **every
      declaration is used** *and* that **every used name is declared**. A one-way test passes while the drift it exists
      to prevent accumulates in the direction nobody checked.
- [ ] An invariant whose enforcement lives on one side of a seam is not enforced. A guardrail that checks a write path
      cannot protect a read-side property; state which side the guardrail is on and which side the defect would be on.

#### 2.0.4 Reachability, exploit scenario, impact

Every security-shaped check in every track — the security track itself, and the authorization items in the backend,
database, validation, configuration, dependency and pipeline tracks — carries three fields, or it is not a finding:

- [ ] **Reachability.** The entry point (method, path, parameter) and the caller's minimum privilege: anonymous
      internet user, authenticated user of the same tenant, authenticated user of a different tenant, holder of a leaked
      credential, or a machine that would first have to be compromised. If the answer is "requires an already-critical
      compromise", the severity is bounded by that, and the finding says so.
- [ ] **Exploit scenario.** One sentence, in the shape "an attacker who is X does Y at Z and obtains W". If you cannot
      write the sentence, you have a code observation, not a vulnerability.
- [ ] **Impact.** What it actually costs given this system's exposure: another tenant's data, a stored credential, an
      unbounded bill, an outage, a regulator-visible disclosure.

Two rules make this discipline load-bearing rather than decorative:

- [ ] **The control must live where the attacker cannot change it.** Anything a client can modify — a route guard, a
      hidden button, a client-side role check — is a usability affordance, never an authorization control. A finding in
      the client's hands is a finding the audit nearly missed.
- [ ] **A negative result is a finding, and it ships with its trigger.** "This class does not apply here" is only
      useful when it names the mechanism that makes it inapplicable and the condition that would change that. A
      negative with no enforcing artefact is a hope, and it decays at the first feature that needs the missing
      capability.

### 2.1 Architecture and layering

**Goal.** Establish where each kind of logic lives, whether the boundaries hold under pressure, and what will break
first as the system grows.

**Read.** The entry point and composition root; the module/feature directory layout; the public surface of each module;
the dependency graph between layers; any documented architecture decisions and their rationale; the test tree (it often
reveals the intended boundaries more honestly than the source does).

**Measure.** Import-cycle detection (many bundlers and linters can do this; if the project has no such check, a
throwaway cycle detector in scratch is acceptable). Fan-in/fan-out per module. Files above an agreed size threshold.
Count of modules that import across a boundary they should not know about.

**Deliverable.** A layered map (component → what it may depend on), a list of violated edges, and a ranked list of the
places where the next change will be expensive.

**Must not conclude without evidence.** Do not claim a cycle, a layering violation, or an SRP violation from file names
and import counts alone; open the offending files and show the actual dependency.

Checklist:

- [ ] Draw the actual dependency graph from imports, not from directory names. Directory names lie; imports do not.
- [ ] Detect import cycles and report each with its full path. Distinguish a benign cycle (a type-only back-reference)
      from a load-bearing one (two modules that genuinely need each other).
- [ ] For each layer boundary, list the legitimate allowed dependencies and the observed ones; report the difference.
- [ ] Find modules that reach past their boundary: transport code doing business logic, presentation code issuing
      queries, domain code importing a UI or HTTP library. Name the file and the import.
- [ ] Check separation of business logic, transport concern, and presentation concern. A handler that contains a
      business rule cannot be unit-tested without a transport; a component that computes a domain decision cannot be
      tested without a component.
- [ ] Apply SRP per unit: list the distinct reasons each class or module changes. A class with four reasons is four
      classes; the cost is in the test setup, not the line count.
- [ ] Assess cohesion: do the members of a module belong to the same concept, or is it a grab-bag that grew by
      convenience? Point at the members that do not belong.
- [ ] Assess coupling: count how many modules must change for one common change (edit amplification). Shotgun surgery is
      the symptom.
- [ ] **Make the unsafe dependency unrepresentable.** Where a layer must never be reached without a piece of context —
      a caller identity, a tenant, a request scope — check whether that context is a **required** parameter. An optional
      one is a per-call-site obligation, and a per-call-site obligation is a defect waiting for a new call site.
- [ ] Look for premature abstraction: a base class, interface, or generic with exactly one implementation, invented
      before a second use case existed. One implementation is a hypothesis, not an abstraction. `MAY`
- [ ] Look for over-abstraction: an indirection layer that forwards to a forwarding layer, or an interface whose only
      method is `doTheThing`.
- [ ] Look for missing abstraction: the same logic copy-pasted in three places, each copy slightly different, each about
      to drift.
- [ ] Check for leaky abstractions: a repository that returns transport-shaped objects, a data structure that leaks its
      internal representation to callers who then mutate it.
- [ ] Identify the composition root and verify dependencies are wired there, not resolved lazily from inside business
      code. Lazy resolution inside a domain method is a test-construction obstacle and a hidden cost.
- [ ] Check whether the container has a test that builds the _real_ graph and fails on a missing dependency. If not,
      that is a preventive-fix candidate for Phase 4.
- [ ] **Enumerate the seams explicitly** and write them down: every place two layers hand data to each other and neither
      owns the other's assumptions. This list is the input to the seam pass (2.24), and a run that does not produce it
      cannot perform that pass.
- [ ] Identify what breaks first as the system grows: the module with the most inbound dependents, the shared type
      edited most often, the service that every feature needs.
- [ ] Check for god objects: units with a large surface, a large dependency set, and a large fan-in. `MAY` — name the
      three measurements that made you say so, or drop the item.
- [ ] Check for circular knowledge between a client and a server contract (see the API-design track) — a shared type
      package that both sides depend on is healthy; duplicated type definitions are not.
- [ ] **Verify that the documented architecture matches the code, including the explanatory comments.** Divergence is a
      finding in its own right: it means every new contributor is misdirected. A comment that explains _why_ something
      is configured a certain way is documentation and is audited as such — see the pipeline track for the
      mechanism-claim check.
- [ ] **Do not audit only the layers the directory tree names.** Ask what the platform's own unit of isolation is (a
      process, an isolate, an object, a container) and whether it matches the layering.

### 2.2 Frontend framework

**Goal.** Establish whether the UI layer uses the framework's reactive model as intended, keeps state in the right
place, and does no work it does not need to do at render time.

**Read.** The component tree and its shell/routing structure; the state stores; the data-access services; shared
framework utilities and test helpers; the project's declared frontend conventions; the framework's own documentation
for the pinned major (re-read it — 0.3).

**Measure.** Count of components by size (template and class). Count of subscriptions not cleaned up. Count of manual
change-detection calls, and what they are compensating for. Count of hand-rolled async fetches versus resource-style
APIs. Split chunk composition. Count of per-action HTTP calls that carry no timeout, cancellation or retry policy.

**Deliverable.** A list of render-path defects, state-placement defects, lifecycle defects, and deprecated-API usages,
each with a file and a line, plus the transport-policy table.

**Must not conclude without evidence.** Do not claim a change-detection problem from a missing optimisation marker
alone; show the template expression, the notification source that should have reached it, and the reason it is
expensive. Do not claim a leak without showing the subscription, timer, or observer and the absence of its teardown.

#### Establish the declared reactivity model first

**This track has a conditional spine, and the branch must be taken before any checklist item below it.** Determine the
model from the framework's own bootstrap configuration, not from a file name:

- **Branch A — a signal-only application.** The framework's scheduler is the only notification source, a component has
  no per-component change-detection mode to be "still on", and the set of notification sources is finite and closed.
  Use the checklist as written, with the deep checks below.
- **Branch B — a zone-based application.** Zone patching is the default notification source and per-component change
  detection still selects the traversal. The items about a closed notification set and about zone-only APIs do not
  apply; the items about manual change detection, template cost and traversal still do.
- **Branch C — mixed, or a scheduler configured per subtree.** A finding by itself: two notification models in one
  application means a class of defect that depends on which subtree a component is in. Resolve it before continuing.

Say which branch you took, and why, in the report. A frontend audit that does not name its branch produces checks that
cannot fail.

Checklist — under both branches:

- [ ] Verify the reactivity model the project declares and confirm every component is consistent with it. Mixed models
      are a finding, not a style preference.
- [ ] Check for legacy module containers. Where the framework's default has moved to standalone declarations this is a
      leftover check rather than a style preference: report what remains, and what it is still doing there.
- [ ] Check signal usage: is derived state computed rather than synchronised manually? A field updated in three places
      to mirror another is a bug waiting to happen; find the manual synchronisations.
- [ ] Find derived state that is actually a plain mutable field. It cannot be tracked and will not update dependents
      reliably. In a signals-first codebase the common form is a writable signal used as a cache of something
      derivable, not a subscription that mutates a field — look for both.
- [ ] Check effect usage: effects that perform data fetching (resource/loader APIs exist for that), effects that write
      signals they also read (loops), effects used to bridge two signals that should be one derived value, and effects
      created where a derived value would do.
- [ ] Find hand-rolled fetching in components: `subscribe` in a component where a resource/loader abstraction is
      available and used elsewhere. Inconsistency here is the actual defect.
- [ ] Check resource-style loads: parameters that are blank or unset yet still trigger a request (the parameter must be
      able to express "do not load"); missing cancellation when parameters change; missing error and empty states; a
      stream that emits before it completes.
- [ ] Check unguarded reads of possibly-absent values. A read that throws when the value is missing is a crash, not a
      style issue; find every read of a loading-or-errorable value and check the guard. Reading the raw value of a
      resource that is still resolving throws; reading it after an error throws differently.
- [ ] Check list rendering: is every list tracked by a stable identity (not by index)? Untracked lists with mutable
      items produce input state attached to the wrong row — a functional bug, not a performance one.
- [ ] Check for keys that are unstable (array index, a value that changes on edit, a hash of a mutable object).
- [ ] Check lazy loading boundaries: are feature areas lazily loaded, or is the whole application in the initial
      bundle? Verify from the build output, not from route declarations. Also check the decisions modern routing adds on
      top of "is it lazy": per-route providers (their lifetime, and what they leak), preloading strategies, and whether a
      "lazy" boundary sits above shared code that defeats the split.
- [ ] Check for a shared "reference data" cache (statuses, types, lookups, members) that is re-fetched per component
      instead of once per context. Count the duplicate requests on a single page load.
- [ ] Check dependency-injection scope: is anything globally scoped that should be request/session scoped, and is
      anything component-scoped that is silently recreated per consumer?
- [ ] Check injection style consistency: mixed constructor injection and functional injection is a finding when the
      project declares one style.
- [ ] Check state placement: server state in a component that destroys it on navigation; global state in a service
      masquerading as a store; the same fact held in two places. Give the item a test: name the navigation that loses
      the state, or drop it.
- [ ] List components and services above the project's size threshold, with line counts and what each one is doing.
- [ ] Check routing: lazy route definitions, guards on every protected route, loaders, redirect rules, wildcard
      handling, and whether a guard actually prevents the load or merely redirects after it.
- [ ] Check for guards that return a redirect instead of blocking, leaving the guarded component in the graph. A
      guard whose fall-through case is not "block" is a guard that lets you in when it is unsure.
- [ ] Check lifecycle: destroy coverage, unsubscribe discipline, teardown tied to component lifetime, and effects tied to
      component lifetime. A teardown that runs twice must be idempotent; a teardown that must not run after an `await`
      needs a staleness guard, not a boolean flag.
- [ ] Hunt leaks explicitly: intervals, timers without clearing, event listeners on global targets, manual observers,
      un-aborted fetches, third-party widgets without destroy calls, and observers without disconnect. For each, show
      the creation site and the absence of teardown.
- [ ] Find deprecated API usages by running the framework's own diagnostics/audit command. Report the exact list; do not
      interpret them.
- [ ] Check naming and file conventions: folder-per-component, template in a separate file where the project declares
      it, selector prefix, no type-suffix filename convention, class name matching its role.
- [ ] Read the project's test-runtime rules and verify existing tests follow them. A test that violates the framework's
      testing rules is flaky or falsely green, and it undermines every number the testing track produces.

Deep checks:

- **DC-2.2-01 Every value a template reads must be reachable from a notification source.** `MUST`
  - **Question.** For each value a template expression reads, is it a signal read, an input, a bound listener, an
    explicitly marked path, or a view-attached value — or is it a plain field, or an external object the framework
    cannot see?
  - **Why.** Under a signal-only scheduler the notification sources are a finite, documented set. That turns a fuzzy
    judgement into a closed-world audit, and it is the difference between "the view updates" and "the view updates
    because something in the list notified it".
  - **Look for.** Plain fields read in templates; objects handed in and mutated later; third-party library instances
    held as fields; template expressions depending on a module singleton.
  - **Evidence.** Per component, the list of template-read expressions and the notification source of each, or the
    absence of one.
  - **Failure modes.** A stale view with no error anywhere. Nothing throws; the screen is simply wrong until something
    else happens to notify it.
  - **Verification.** Change the underlying value without touching anything else, and observe whether the view updates.
    In a test, assert the notification path rather than forcing a detection call — a test that forces the render
    proves the render, not the notification.
  - **Sources.** The framework's change-detection and signals documentation for the pinned major; its testing guide for
    the runtime rules.
  - **Freshness.** Re-check the documented notification sources on every major, and whenever a runtime adds one. This
    is the most version-sensitive statement in this track.
- **DC-2.2-02 A manual change-detection call is evidence of a broken notification path, not a performance smell.**
  `SHOULD`
  - **Question.** Every manual detection or mark call: what is it compensating for, and which notification was supposed
    to have arrived?
  - **Why.** Under a signal-only scheduler a manual call means something upstream does not notify. It is a workaround
    placed on top of an unknown, and it makes the real defect invisible to the next reader.
  - **Look for.** Manual detection calls in production code; in tests, a forced detection call used to make an assertion
    pass.
  - **Evidence.** Each call site, with the component and the value it was forcing.
  - **Failure modes.** A test that forces the render passes while the notification path is broken — the test asserts
    the workaround.
  - **Verification.** Remove the call and observe whether the behaviour still works. If it does, the call is noise; if
    it does not, the missing notification is the finding.
  - **Sources.** Framework change-detection documentation; the project's own testing notes.
  - **Freshness.** Re-check whether the framework has removed the need for the pattern; the guidance changes as the
    scheduler improves.
- **DC-2.2-03 Stability and mutability APIs outside their supported model are silent no-ops.** `MUST`
  - **Question.** Does the code use any API the current reactivity model does not notify from — including
    framework-provided stability utilities that only work under a zone, and mutating a reactive model's internal state
    from outside its API?
  - **Why.** This is the largest defect class in this track precisely because the usual evidence is missing: nothing
    throws. The observable is that the mechanism no longer fires.
  - **Look for.** Post-hoc stability helpers that emit nothing; direct mutation of a reactive model's state (assigning
    into a bound collection, replacing a form model's value) instead of using its API; a callback registered on a
    library that no longer schedules a change.
  - **Evidence.** The mechanism's own documented contract for the pinned version, plus an observation that the
    notification does or does not arrive.
  - **Failure modes.** A form that shows a value the user never typed; a value that appears only after some unrelated
    interaction; a test that passes because it forces the update.
  - **Verification.** Drive the mechanism with a single input and assert the observable state, with nothing else
    happening. A test that also touches another control proves nothing.
  - **Sources.** The framework's zone/stability documentation and migration guide for the pinned major — the exact
    boundary of this class moved between majors.
  - **Freshness.** HIGH. Re-read the migration guide for the pinned major and for the one before it. Do not rely on
    this document's list of which APIs are affected.
- **DC-2.2-04 The render cost unit is a notification, not a tick.** `MUST`
  - **Question.** Under a signal-only scheduler, what exactly re-runs per notification, and which of the values a
    notification invalidates are actually derived rather than recomputed?
  - **Why.** "Expensive template expression" was written for a model where every check re-evaluated everything. Here a
    notification re-runs only the affected expressions, so the old question is not merely imprecise — it is
    unanswerable.
  - **Look for.** Function calls, pipelines, object construction and date formatting in templates that run per
    notification; a value that is a plain field where a derived value would be recomputed only when its inputs change.
  - **Evidence.** The expression, and the notification that triggers it.
  - **Failure modes.** A cheap expression recomputed on every keystroke, because the whole view is invalidated by an
    unrelated signal.
  - **Verification.** A profile or a trace, with the input stated. Counting evaluations by reading is not evidence.
  - **Sources.** Framework rendering documentation for the pinned major; the reactivity guide's guidance on derived
    values.
  - **Freshness.** Re-check on every major; the scheduler's invalidation granularity is an implementation detail that
    can change.
- **DC-2.2-05 Client-side guards and hidden controls are UX, never authorization.** `MUST`
  - **Question.** For every client-side guard, role check, or conditionally rendered control, is there a server-side
    assertion of the same rule — and is the client-side one described in the report as a UX affordance rather than a
    control?
  - **Why.** The client is fully attacker-controlled. A route guard, a structural directive, or a hidden button is
    discoverable and removable by whoever wants to.
  - **Look for.** Guards that only redirect; permission directives with no server counterpart; buttons hidden by
    permission with the endpoint still open; client code computing an authorization decision.
  - **Evidence.** For each client guard, the server-side assertion of the same rule, or its absence.
  - **Failure modes.** A route reachable by anyone who asks directly, while the audit found nothing because the UI
    looked correct.
  - **Verification.** For each guarded operation, call the endpoint with the insufficient identity and assert the
    refusal.
  - **Sources.** The reachability clause (2.0.4); the framework's router-guard documentation, which states the same
    limitation.
  - **Freshness.** LOW for the principle. Re-read the router documentation only if the guard API itself is in question.
- **DC-2.2-06 Transport policy: every user action declares timeout, cancellation and retry.** `MUST`
  - **Question.** For each class of user action, what is the timeout, what cancels the in-flight request when the
    parameters change or the view is destroyed, and what retries — with what backoff, jitter, and budget?
  - **Why.** These three are the transport's contract with the server and with the user's time. Their absence is not a
    performance defect; it is an unbounded wait and an unclaimed duplicate-effect risk. No framework check asks whether
    a policy exists, because the policy is a statement, not an API call.
  - **Look for.** Requests with no timeout; subscriptions that outlive their component; parameters that change without
    cancelling the previous request; a retry loop with no jitter or no budget; a "retry" that is really a silent
    re-request on the next navigation.
  - **Evidence.** A table: action class, timeout, cancellation mechanism, retry policy. "None, deliberately" is a valid
    cell; a blank cell is the finding.
  - **Failure modes.** A superseded request resolving after its replacement and overwriting newer data; a slow failure
    leaving the UI pending with no error; a retry multiplying a non-idempotent write.
  - **Verification.** Change the parameters mid-flight and assert the superseded request was abandoned and cannot win
    the race. For retries, count attempts against the budget.
  - **Sources.** The framework's HTTP and resource documentation for the pinned major (what the resource layer already
    cancels for you, so the check is about the rest); general retry guidance for backoff with jitter.
  - **Freshness.** MEDIUM. The resource layer's cancellation and sharing behaviour is an implementation detail; confirm
    what it does for you before writing a policy that duplicates it.
- **DC-2.2-07 A third-party library that owns DOM must be attached, guarded and destroyed explicitly.** `MUST`
  - **Question.** For each embedded or imperative library: where is it attached, what tells the framework the DOM
    changed, and what tears it down? Is any `await` between the decision to initialise and the completion, and is the
    result discarded if the inputs changed in the meantime?
  - **Why.** A signal-only scheduler does not observe mutations a library makes to DOM it owns, so a widget can render
    correctly and then stop tracking. And an async initialisation that resolves after its inputs changed will apply
    stale content — the classic "flap" nobody can reproduce.
  - **Look for.** Libraries attached without a post-render hook; creation inside a plain call rather than a lifecycle
    hook; `await` between setup and use without a staleness check; teardown that is not idempotent; a component
    re-created by a structural directive (a conditional block, a loop) with a library instance held in a field.
  - **Evidence.** The creation site, the notification hook, the teardown site, and every `await` on the path.
  - **Failure modes.** A widget that renders once and never updates; a stale editor re-attaching over a fresh one; a
    double-destroy throwing on the second call.
  - **Verification.** Re-create the owning component twice in a row and assert single attachment and clean teardown;
    change the input during initialisation and assert the stale result is discarded.
  - **Sources.** The framework's rendering and lifecycle hooks; the third-party library's own teardown contract. The
    library's source is the authority, not its example.
  - **Freshness.** MEDIUM. Hook names and teardown contracts move; the required shape (explicit attach, explicit
    notification, idempotent teardown) is stable.
- **DC-2.2-08 HTTP responses are not runtime-validated by default.** `CONTEXT-DEPENDENT`
  - **Question.** Is the client treating a typed response as trusted at runtime, and if the server is not
    first-party-versioned in lockstep, what validates the payload?
  - **Why.** Type annotations on a response are erased at runtime. A contract that can drift needs either a shared
    schema or a stated acceptance that the two deploys are atomic.
  - **Look for.** A response cast to a shared type with no parse; a client that tolerates extra fields it does not know
    about; a shared contract consumed by two independently versioned targets.
  - **Evidence.** The parse (or its absence) at the client boundary, and the deployment coupling that makes it safe.
  - **Failure modes.** A field that becomes optional on the server and is dereferenced unconditionally on the client.
  - **Verification.** Change the server response shape in a test and observe what the client does.
  - **Sources.** The schema library's interop specification; the framework's resource parsing support for the pinned
    major.
  - **Freshness.** MEDIUM. Interop and client-side parsing support both changed recently; confirm what the pinned
    versions support before recommending either.

#### 2.2.1 The client-side form layer

Signal-based form frameworks, and their equivalents, are a **first-class layer with no equivalent in the server-side
validation track**, and their semantics differ from the older reactive-forms model. An auditor who knows reactive forms
will mis-predict signal forms in ways that produce confident wrong findings.

**Goal.** Establish that the client form layer validates exhaustively, reports its states truthfully, and does not
silently disagree with the server.

**Read.** The form field definitions and schemas; the validation rule functions; the error-message sources; the
disabled/hidden/readonly handling; the server-error integration path; the form control components and how state is
bound to them; the test coverage of the form layer.

**Measure.** Count of fields with an explicit validity assertion in a test. Count of error messages that are literals
rather than translation keys. Count of fields marked hidden/disabled/readonly. Count of async validators.

**Deliverable.** A per-field table of (rule, state reported, error surfaced, submitted or not), plus the list of
validity states the UI treats as "valid" without checking.

**Must not conclude without evidence.** Do not conclude a form is accessible from the presence of a label element; the
error association is what matters. Do not conclude a field's value reaches the server from the template; trace the
submit path.

Checklist:

- [ ] **Establish the semantics first.** Write down, from the framework's own documentation for the pinned version, the
      validation order (exhaustive or short-circuiting), the validity states, and how a field reports "being
      validated". Predictions made from another model are the defect class here.
- [ ] **Validity is a state, not a boolean.** Find every place the UI branches on validity: an asynchronous validator
      that is running reads as neither valid nor invalid, so a submit button that requires "valid" disables during
      validation and for the wrong reason. Check whether the UI's notion of valid includes the pending state.
- [ ] **Find fields that skip validation.** A field marked disabled, hidden, or read-only is typically not validated. The
      dangerous half is not that it is skipped — it is whether it is still **submitted**. A required field hidden from
      the user and still sent in the payload is a validation hole with a user-visible symptom.
- [ ] **Check the native validity API.** A CSS pseudo-class driven by native constraint validation reflects the
      browser's own validity, which is not the same thing as the framework's. `:invalid` firing on a field the framework
      considers valid, or the reverse, is a real defect, and the happy-path screenshot does not show it.
- [ ] **Check how server errors reach the form.** There is usually one supported path for attaching a server's
      field-level errors to a field; other paths either do not exist or are unsupported. Find the path in use and
      confirm the field's error state actually changes — an error that is returned but never attached is the most
      common defect in this layer.
- [ ] **Check cross-field rules.** A rule that reads another field's validity, and especially an ancestor's, can recurse
      indefinitely. Check whether any rule depends on a validity state it also influences.
- [ ] **Check accessibility wiring as a first-class item.** The form framework supplies validation state; it does not
      supply the ARIA attributes. For each invalid field: is the error programmatically associated with the control, is
      the invalid state exposed, and is a busy state exposed while validation runs? A codebase can use this layer
      correctly and be unusable with a screen reader.
- [ ] **Check the composition between the form layer and the design system's form controls.** A headless field control
      must be attached for the wrapper's error display to be reachable; a control that renders the field but not the
      error is a field that looks correct and communicates nothing.
- [ ] **Check async validation hygiene.** Uncancelled async validators, no debouncing of a network-backed rule, and a
      rule whose result arrives after the field changed.
- [ ] **Check message sources.** Hardcoded strings in a translated product are both a localisation defect and a
      contract: they cannot be reordered per locale, and they bypass the translation catalogue's parity check.
- [ ] **Check client/server agreement.** See the validation track's parity item; the client copy is a UX affordance and
      the server is the authority, and the two drift silently.

Deep check:

- **DC-2.2-09 The client form's accessibility wiring is the application's job.** `MUST`
  - **Question.** For every field, is the error associated with the control, the invalid state exposed, and the pending
    state exposed — or is that assumed because the framework provides validation?
  - **Why.** A form layer that validates does not automatically name, describe or invalidate anything for assistive
    technology, and the framework's own composition helpers for this have changed status across releases. Nothing in the
    framework flags its absence.
  - **Look for.** Invalid fields with no invalid-state attribute; error text rendered as a sibling with no programmatic
    association; a description used as the control's name; a busy state during async validation that is not exposed; a
    field whose error is visible only when the form is re-rendered.
  - **Evidence.** For each field, the association between the control and the error/description element, taken from the
    rendered output.
  - **Failure modes.** A form a screen-reader user can complete with no error ever announced.
  - **Verification.** Assert the state attributes in the rendered DOM for one invalid and one pending field, rather
    than asserting that a validation function returned an error.
  - **Sources.** The accessibility track (2.17); the framework's forms accessibility documentation for the pinned
    version, and its own issue tracker for open gaps in the composition helpers.
  - **Freshness.** HIGH. This area is actively changing; a composition helper referenced by older guidance may be
    experimental, changed, or removed. Re-read before recommending one.

### 2.3 UI library and design system

**Goal.** Establish that the UI is built from the design system, that design decisions are expressed as tokens, and that
vendored library code is not being patched by hand.

**Read.** The design-system dependency list and configuration; the token/theme definition; the project's component
inventory; any vendored or generated component code; the styling configuration and its ordering.

**Measure.** Count of hand-rolled lookalike components versus design-system components. Count of raw colour/spacing
values in templates and styles. Count of style rules that override library internals. Size of vendored directories.

**Deliverable.** The artefact inventory (below) plus a list of lookalikes, token violations, overrides, and
vendored-code hazards, each with a file.

**Must not conclude without evidence.** Do not claim a lookalike from a similar name; show the two implementations side
by side. Do not claim an unused vendored file without checking for dynamic references (string-based imports, route-level
loading, registration side effects).

#### Inventory the artefacts before asking about styles

**An audit that reasons from build output is structurally blind to most of a modern UI surface.** Before any defect check
in this track, list for each part of the design system: **is it a package dependency, vendored source in the
repository, or fetched at runtime?** Then answer one question: which of the three does a build-output inspection see?

- A vendored styled layer is invisible to a bundle analysis, to a version check on the package, and to an upgrade
  command. It is also the layer most likely to drift from its upstream, because upgrading the package changes something
  nobody is using.
- A runtime-fetched asset (a theme stylesheet, a translation file, a font) is invisible to the bundle budget, has no
  fingerprint, and is governed by a cache policy that lives in a different file from the build.
- A package dependency is the easy case, and it is the minority of a well-built system.

Report the inventory as a table before the checklist, and mark every subsequent finding with which artefact class it
came from.

Checklist:

- [ ] Build the artefact inventory described above, and note for each part whether a build-output check would see it.
- [ ] **Version skew between the layers.** When a design system is partly a dependency and partly vendored source,
      record both versions and the date of the last re-generation. A vendored layer behind its own upstream is a fork
      nobody owns, and the version on the manifest is not the version in the tree.
- [ ] Inventory the design system in use and verify the project consumes the styled layer rather than the headless
      primitives, where the project declares a styled layer.
- [ ] Find hand-rolled components that duplicate an existing design-system component (dialog, select, dropdown, button,
      toast, tooltip, combobox, tabs, table). Show the duplication and estimate the maintenance cost.
- [ ] Find the reverse: headless primitives used directly, without the project's styling layer, producing unstyled or
      inconsistently styled output.
- [ ] Check the primitive/styled split where it exists: primitives must not carry visual decisions; styled components
      must not contain behaviour. A styling concern inside a primitive is a leak in the wrong direction.
- [ ] **A headless primitive's accessibility is a contract per usage, not a property of the library.** For each usage,
      check the name, the role, the state attributes and the keyboard behaviour against the primitive's documented
      contract. The library's own history is the argument: shipped defaults have changed without a major release, and a
      component that satisfies the contract can still be inaccessible because the consumer did not pass the state the
      primitive needs.
- [ ] **Check where overlays render.** Dialogs, menus, popovers and tooltips that render in a document-level portal are
      outside the component's own tree: a check that walks the component subtree, or a scoped style, will not see them —
      and neither will a screenshot cropped to the component.
- [ ] **Check dismissal defaults as a behavioural contract, not a preference.** Whether escape closes, whether outside
      click closes, whether focus returns to the trigger: record what the project relies on, and test it, because these
      defaults have changed inside minor releases.
- [ ] Verify design tokens are semantic (`surface-raised`, not `gray-100`) and that raw values are not used where a
      token exists. List each raw value with its location.
- [ ] Check for a two-tier token system (primitive values plus semantic aliases). Missing semantic aliases force every
      component to pick a raw value and makes theme changes a sweep. Where the styling framework has its own token layer
      there are **two** systems: verify the project's tokens are actually consumed rather than shadowed.
- [ ] Check theme support: is there a dark or alternate theme, and do components reference tokens rather than fixed
      colours so the theme actually applies? **Ask how dark mode is actually achieved**, and compare it with the
      mechanism the styling framework's variants assume — a variant whose class the project never emits produces
      utilities that compile and are then dead.
- [ ] Check contrast-relevant choices: text and icon colours taken from tokens that meet contrast, or hand-picked.
- [ ] Find long class-expression strings in templates. They defeat tooling (lint rules, formatter sorting) and hide
      inconsistency. Note the length threshold you used and say so.
- [ ] Check the class-merge/composition helper is used consistently when composing conditional classes. A raw
      interpolation instead of a merge helper silently drops conflicting utilities.
- [ ] Check for CSS leaking across components: global element selectors, unscoped class rules, resets applied globally,
      styles that reach into child component internals.
- [ ] Check for style overrides of library internals (deep selectors, `!important`, specificity wars). Each one is a
      coupling to an implementation detail that a library upgrade will break.
- [ ] **Vendored-code hazard.** If any library component code is vendored into the repository (copied to be modified),
      establish which parts are vendored, why, and what the re-generation procedure is. Record the hazard explicitly:
      regenerating will silently discard local modifications, and a modification that is never re-merged is a fork
      nobody owns. Propose a guardrail (a header marker plus a check) rather than a fix.
- [ ] Check for accessibility defaults that the design system provides and the project has overridden away.
- [ ] Check icon usage: one icon source, consistent sizing, decorative icons marked as such, icon-only controls carrying
      an accessible name, and whether the icon registry contains only the icons actually used.
- [ ] Check the component inventory against the framework's own "unused" diagnostics where available, and against a
      manual import-graph search.
- [ ] Dynamically-computed class names: the styling track (2.16) owns that check. Do not report it twice.

#### 2.3.1 Localization and the translation catalogue

A translation catalogue is a **build artefact with a CI obligation**, not a set of files. Missing keys, keys present in
one locale and absent in another, and a base locale that has drifted from the keys the code uses are three different
defects with three different owners, and none of them is visible in the running app in the author's language.

**Goal.** Establish that every key the code uses exists, that every key exists in every locale, and that the mechanism
for switching languages cannot race the things language-dependent rendering depends on.

**Read.** The translation files; the loading configuration; the key-extraction script if one exists; the language-switch
handler; the date/number/relative-time formatting configuration; the interpolation usage.

**Measure.** Keys used in code and missing from the base locale. Keys in the base locale and missing from each other
locale. Keys in the base locale and used nowhere. Per-locale payload size. Count of interpolation sites.

**Deliverable.** A three-way parity table (used / base / each locale) and a list of the silent-failure mechanisms.

**Must not conclude without evidence.** Do not report a missing key from a scan of one file; enumerate. Do not report a
switch race from reading the handler — reproduce it or prove the ordering.

Checklist:

- [ ] **Parity is a three-way diff, not a two-way one.** Compare keys used in code against the base locale, and each
      locale against the base. A two-way comparison (base against one locale) misses the most damaging case: a key added
      to the code and to one locale only, which is a runtime key string in every other language.
- [ ] **Determine whether a missing key fails loudly or silently.** This is configuration, and both settings are
      legitimate. If it falls back silently, no key check can rely on the running app, and a missing key is a production
      defect with no error — decide whether the project's own rule is "loud", and make the parity check the thing that
      enforces it.
- [ ] **Check the switch path for ordering.** Language switching is several asynchronous chains: the language signal,
      the locale-data registration that the date and number pipes depend on, the re-translation of every live view, and
      any component that instantiated a formatting pipe in a field. The failure is a first render in the new language
      occurring before the data that render depends on is ready. Verify by switching rapidly between two languages with
      a date on screen.
- [ ] **Check the interpolation boundary as an injection surface.** Interpolated values land in HTML; a value that is
      untrusted, or a translation string that itself contains markup, crosses the sanitiser boundary. Check both
      directions: user data interpolated into a translated string, and a translation string containing markup.
- [ ] **Check what the formatter cost is per call site.** A pipe invoked in a template is a subscription per call site;
      in a large table this is measurable, and it is invisible without a profile.
- [ ] **Check locale-data registration is complete and eager for the active language.** A framework that formats dates
      using locale data throws when the data for the active locale is not registered. Verify registration happens before
      the first render that needs it, for every locale the product claims to support.
- [ ] **Measure the per-locale payload.** Locale files are runtime assets or lazy chunks: report their size, their cache
      policy, and whether the shipping app downloads every locale or only the active one.
- [ ] **Check the format-versus-translate split.** Dates, numbers, currency and relative times are formatted, not
      translated; a date passed through a translation key is a bug in one language and mojibake in another.
- [ ] **Check the accessibility consequence of translation.** Longer and shorter strings reflow; a layout that works in
      the author's language is not evidence for the longest locale. See 2.17.

Deep check:

- **DC-2.3-01 Key parity is a CI artefact, and the extraction must be from the code.** `MUST`
  - **Question.** Does the pipeline compute the three-way diff (used / base / every locale), and is the base locale's
    completeness enforced separately from inter-locale equality?
  - **Why.** Equality between locales can be perfect while every one of them is missing a key the code uses. Only the
    code side knows the truth, and only one language is ever rendered in review.
  - **Look for.** A parity script that compares locale files to each other; a base locale maintained by hand; a
    key-extraction step that is a convention rather than a command; unused keys never reported.
  - **Evidence.** The script, its output, and whether it is wired into the blocking gate.
  - **Failure modes.** A user in any language sees a raw key, and the report says localisation is complete because all
    the files match.
  - **Verification.** Add a key to the code in a scratch branch and confirm the check fails; remove a key from one locale
    and confirm it fails.
  - **Sources.** The translation library's documentation for the pinned version and its key-parity tooling, if any.
  - **Freshness.** MEDIUM. The library's tooling changes; re-read before recommending a specific script.

#### 2.3.2 Rich-text surfaces

A rich-text editor is a **security boundary, a round-trip data contract, a third-party DOM owner, and an accessibility
surface**, and it is usually audited as none of them.

**Goal.** Establish what is stored, what renders it, and what would happen to the stored value when the first consumer
that is not the editor appears.

**Read.** The editor's configuration; every producer of rich-text content; every consumer; the sanitisation applied at
each sink; the serialisation round trip; the editor's destroy path.

**Measure.** Count of fields holding rich text. Count of renderers per field. Count of sanitiser call sites.

**Deliverable.** A **consumer inventory** per stored field: every renderer, and — explicitly — the consumers that do
**not** exist yet, by name (export, e-mail, notification, search index, public API, document export). That list of absent
consumers is the deliverable: the day one appears, the absence is a recognised event rather than a silent posture
change.

**Must not conclude without evidence.** Do not report that stored content is safe because the editor sanitises links.
Sanitisation at a DOM sink protects that sink; the stored value is verbatim, and the next consumer may not sanitise at
all. Conversely, do not report stored script injection without a consumer that renders it.

Checklist:

- [ ] **Establish the stored-value contract.** What exactly is persisted — markup, markdown, or a document tree — and is
      it stored verbatim? Record it.
- [ ] **Inventory every consumer of the stored value**, including the editor itself mounted read-only, and prove the
      inventory: search for the raw-assignment sinks, the HTML sinks and the renderers, not just the type name.
- [ ] **Name the absent consumers.** For each plausible future consumer (export, e-mail, search index, notification),
      state what sanitisation it would need. This is what turns "safe today by the absence of a renderer" into a
      decision rather than a coincidence.
- [ ] **Check every sink, not the writer.** Sanitisation belongs at the render sink; sanitising at write time corrupts
      the round trip and fixes no consumer. Check that no write-time filtering exists, and that each sink has its own
      control.
- [ ] **Check link and resource URLs at every sink**: scheme allow-list, and whether the check covers images and any
      embedded node type as well as links. A link allow-list that does not cover the image source is half a control.
- [ ] **Check the round trip as a data contract.** Define what content must survive edit, store, render, edit unchanged,
      and build a fixture set that asserts it. Serialisation loss is silent, cumulative, and only discovered by a user.
- [ ] **Check the editor's integration against the reactivity model**: explicit attach, notification on change,
      idempotent teardown, and a staleness guard across every `await` between setup and use (see DC-2.2-07).
- [ ] **Check reverse synchronisation.** The one-directional flow (editor to model) is easy; the other direction (model
      to editor) is where a boolean "is it the same content" flag belongs, and a boolean flag is wrong the moment two
      updates interleave. It wants a staleness epoch or an equivalent identity check.
- [ ] **Check the accessibility surface.** A rich-text editor is a widget with a toolbar, a value, and a focus model,
      and it has no accessible default. Check the toolbar's names, the value's role and label, the keyboard model, and
      whether the value's plain text is exposed.
- [ ] **Check plugins that parse content** (highlighting, math, mentions) for an allow-list of what they accept.
- [ ] **Check the fallback path.** A fallback mode (a plain textarea when the editor cannot initialise) is not graceful
      degradation unless the stored format is readable and writable in both modes.
- [ ] **Check the clipboard as an entry point** if any custom paste handling exists; otherwise record the default as the
      trust boundary.

### 2.4 Types and domain model

**Goal.** Decide whether the type system describes the domain, or merely makes the existing code compile under pressure.
Lead every judgement in this track with that question.

**Read.** The shared/domain type definitions; validation schemas; the persistence/document shapes; the transport types
on both sides; the compiler strictness configuration.

**Measure.** Count of escape hatches: `any`, non-null assertions, double assertions, `unknown` that is immediately cast,
`@ts-ignore`/`@ts-expect-error` with a reason, and disabled lint rules on type lines. Then, per strictness flag, count
the real errors in a throwaway configuration.

**Deliverable.** A verdict per type cluster — descriptive or merely strict — plus a ranked list of escape hatches and
mismatches.

**Must not conclude without evidence.** Do not report an `any` without finding what it actually holds. Do not report a
type mismatch between schema and stored document without a query that demonstrates the mismatch. Do not propose enabling
a strictness flag without the error count that flag produces.

Checklist:

- [ ] For each core domain type, ask: does this describe the domain, or is it a transcription of what the current code
      happens to do? Write the answer down per type.
- [ ] **Distinguish compile-time safety from runtime safety.** A required parameter or a closed type prevents a call; it
      does not check a value. Record, for each invariant, which half the type system actually gives you — a type that
      cannot be wrong and a value that is merely well-typed are different artefacts with different failure modes, and
      the second is what the audit usually means by "typed".
- [ ] **Check that a cross-cutting obligation is a required parameter everywhere it applies.** An optional context
      parameter on a tenant-scoped or request-scoped method is a per-call-site obligation, and a call site added later
      silently omits it. This is the highest-value type-level guardrail in a layered application, because it moves the
      failure from runtime to compile time.
- [ ] Inventory escape hatches per file. For each, state what the honest type would be. An `any` with a comment
      explaining a genuine platform limitation is acceptable and should be recorded as such.
- [ ] Distinguish `unknown` from `any`. `unknown` forces a check; `any` disables one. Find `unknown` that is cast
      immediately without narrowing — it is `any` with extra steps.
- [ ] Check discriminated unions: are the states of an entity modelled as a union with a discriminating field, and do
      handlers narrow exhaustively? A boolean-per-state explosion (`isX`, `isY`, `isZ`) is a union written badly.
- [ ] Check that narrowing is exhaustive. Find switches or conditionals over a union with no default and no
      exhaustiveness assertion; adding a variant will silently skip handling.
- [ ] Check nullability and optionality semantics: does `?` mean "absent" or "maybe unknown"? Is the difference
      documented? A field that is optional in the type but required by the database produces runtime failures that types
      cannot catch — and under an exact-optional-properties setting, "maybe undefined" is a different type from
      "absent", which is the point of the flag and worth stating.
- [ ] Check for types duplicated across layers: the same entity defined in the domain, in the transport contract, and in
      the persistence layer, drifting apart. Identify which of the three is authoritative.
- [ ] Check the agreement chain: type ↔ validation schema ↔ stored document. A field validated but not typed, typed but
      not validated, or typed but stored under a different name, is a finding each time.
- [ ] Check whether stored documents are typed at all. Documents written by an older version of the code are the
      population your type is wrong about; the type describes the present tense only.
- [ ] Find types that are inferable and should not be written out (a type that restates a function's return shape, a
      manual mirror of a schema). Prefer deriving from one source.
- [ ] Check for branded/nominal identifiers. If a project id and a user id are both plain strings, a swapped argument
      compiles; branding is cheap prevention.
- [ ] Check for primitive obsession: strings used for states, kinds, and units where a union or a small value object
      would make illegal states unrepresentable. Rank by how often the string is compared or switched on.
- [ ] **Measure each strictness flag honestly:** copy the compiler configuration into a throwaway file in scratch,
      enable exactly one flag, run the type check, and count the errors. Report the count and the three most common
      error shapes. Do not change the real configuration. Do not estimate — an estimate is how a two-hour fix becomes a
      two-week project.
- [ ] Note that enabling a flag can surface genuine bugs, not just noise. Categorise the counted errors into "annotation
      debt" and "real defect exposed" and report the split; the second category outranks almost everything else in this
      track.
- [ ] Check the escape-hatch guards that already exist in the project (lint bans, source-scanning tests). If a ban
      exists with a baseline count, do not raise the count; report where the new ones are.
- [ ] Check type-only imports and verbatim module syntax settings for accidental runtime retention.
- [ ] Do not propose making types stricter for its own sake. Strictness that no runtime check backs is documentation the
      compiler enforces; it does not make the system correct.
- [ ] Do not propose papering over a real mismatch with a cast. A cast on a genuine type/schema/document disagreement
      hides the disagreement permanently.

### 2.5 Backend HTTP and platform

**Goal.** Establish that the request pipeline is uniform, correctly ordered, and safe on the platform it runs on.

**Read.** The server entry point; the middleware stack and its registration order; the router composition; the error
handler; authn/authz middleware; the platform configuration file and its bindings; the worker/handler entry.

**Measure.** Routes without a required middleware. Middleware registered after routes (silently ineffective). Number of
handlers constructing responses by hand versus via the shared envelope. Number of module-level mutable singletons.
Number of module-level I/O objects. Cold-start time if measurable.

**Deliverable.** An ordered middleware map with per-route coverage, an error-path map, a **topology statement** (see
below), and a list of platform configuration defects.

**Must not conclude without evidence.** Do not claim a middleware is missing from a route table without enumerating the
full route table. Do not claim a module-level singleton is shared across requests without showing both that the runtime
keeps the module scope alive and that the state is mutable.

#### Establish the topology first

**On a distributed runtime, almost every question in this track has a topology-dependent answer, and the topology is a
statement, not a guess.** Before any other item, write down: where the I/O objects (database client, cache, session
store) are created; in which scope they live; what that scope's lifetime is; and what happens to in-memory state when
the scope is destroyed. Then answer these three:

- Is a module-scoped object shared by every request, scoped to one long-lived instance, or scoped to one object
  identity? **The same code has different legality in each scope**: a value cached in module scope is a cross-request
  defect in a stateless runtime and a legal, deliberate optimisation inside a single-threaded object whose lifetime
  bounds it. Any check phrased "never cache a client" is incomplete and dangerous; the check names the scope.
- What in-memory state exists, and what is its real ceiling — per request, per instance, or for the whole application?
  A counter held in memory is a control whose effectiveness is `limit × instances`, and the second factor is often
  decided by a routing choice and a performance flag rather than by anyone thinking about the control.
- What does the platform actually guarantee about each primitive the design depends on? Write the table in DC-2.5-01
  before making any reliability claim.

Checklist:

- [ ] Build the complete route table: method, path, params, which middleware covers it, which handler serves it. Every
      id-bearing route appears. A route missing from this table is a route nobody audited.
- [ ] Verify middleware **order**: correlation/id first, then parsing, then authn, then authz, then validation, then
      handler, then error handling last. Order errors are silent and severe — a validation middleware after the handler
      never runs. **That sequence is a convention this document recommends, not a requirement any specification
      states**, so record why it is that order wherever a specific guarantee depends on it: name the two middlewares
      that are order-sensitive, the guarantee, and the consequence of swapping them. An ordering nobody can justify is
      an ordering the next contributor will reorder.
- [ ] Verify per-route coverage: is each middleware mounted globally, per router, or per route? A middleware applied in
      some routers and forgotten in another is the classic finding.
- [ ] Check that error handling is genuinely global: an exception thrown in middleware, in a not-found handler, and in
      an unhandled promise are all converted to the same envelope.
- [ ] Check the error envelope shape is produced in exactly one place, and no handler hand-rolls an error body.
- [ ] Check authn: how the token is parsed, verified, and expired; what happens on a missing, malformed, expired, or
      wrong-algorithm token; whether algorithm confusion is possible; whether every claim the design relies on is
      actually present in the token (see the security track).
- [ ] Check authz: coarse role checks at the route, fine-grained permission checks in the service, and whether
      authorisation ever reads an id from the request body or path as the authority for access.
- [ ] Check the multi-tenant seam: is every tenant-scoped operation resolved through the caller's context, and is a
      cross-tenant id rejected indistinguishably from "not found"? The security track owns the decision; this track
      records whether the seam is mounted once or per route.
- [ ] Check CORS: allowed origins (explicit list, not a wildcard with credentials), allowed methods, allowed headers,
      exposed headers, and whether the configuration differs per environment. A CORS allow-list is a browser mechanism,
      not an authorization control — state that in the report so nobody reads the two as one.
- [ ] Check rate limiting: which routes are limited, whether the limit is per-identity or per-IP, the window, the store,
      and whether the response carries the standard retry headers. Then do the arithmetic the security track asks for.
- [ ] Check input validation coverage per route: body, path, query, headers. See 2.7.
- [ ] Check response headers: security headers, cache-control on authenticated responses, and whether any authenticated
      response is cacheable by a shared cache. Security headers are frequently set at the edge rather than in code — a
      code-level search reporting "none" is a question about the deployment, not an absence.
- [ ] Check CORS preflight handling and whether the preflight path is rate limited.
- [ ] Check payload size limits: body size cap, maximum array lengths, maximum string lengths, and whether the limits
      are enforced before parsing.
- [ ] Check idempotency: which mutating routes are safe to retry, which are not, and whether any client, proxy or load
      balancer retries automatically. Classify each mutating route (always-idempotent / conditionally / never).
- [ ] **Split the state question by scope.** For each piece of cross-request state, answer in two columns: what happens
      in module scope (shared by every request in that instance), and what happens in object scope (shared by every
      request routed to that object). The two columns have different answers and different defects, and a single-column
      question produces both a false positive (a legal pattern read as a leak) and a false negative (a hard runtime
      error read as a leak).
- [ ] Check timeouts: database query timeouts, upstream call timeouts, and whether the platform's own limits are
      respected. On a CPU-metered runtime the budget is CPU time, not wall clock, and a query that waits on I/O consumes
      a different budget from one that burns it.
- [ ] Check cancellation: when the client disconnects, is work abandoned? Long work without cancellation wastes capacity
      and holds locks.
- [ ] **Classify "after the response" work.** Anything scheduled to run once the response is sent has a bounded, silent
      window and is lost without an error. Decide per item whether it is durable work or best-effort, and record the
      decision. On a platform with no shutdown hook, the answer to "how do we stop cleanly" is that we do not.
- [ ] Check secrets and bindings: what is required, what is optional, and what happens if a required secret is missing.
      "Fail fast at boot" is unavailable on a runtime with no boot phase; the achievable equivalent is a readiness
      contract that reports not-ready until the required configuration is present.
- [ ] **The deployed value of a mode variable is a deployment fact.** When a variable selects a topology, a pool size, a
      security posture or a limit, read the deploy command and the platform configuration, and reconcile every prose
      statement of its default — entry documents, config comments, code comments — against it. A comment that says "the
      production default is X" while the deploy sets Y is a finding, and it is the kind that misleads the next reader
      for years.
- [ ] Check cold start: what runs at module load. Heavy top-level work, large data imports, schema construction, and
      synchronously initialised clients all land in the cold path, where the platform enforces a hard startup budget.
- [ ] Check for redundant round-trips: a handler that fetches a parent entity to authorise and then fetches the same
      data again to render; a loop issuing one query per item.
- [ ] Check connection pooling: pool size, whether it is bounded, whether it is recreated per request, and whether the
      pool outlives the request in a way the platform permits. The two inputs to pool sizing — peak concurrent
      operations and the concurrency ceiling of the execution unit — are usually both unmeasured, and their absence is
      the finding.
- [ ] Check the platform configuration: compatibility flags, limits, observability settings, routes that must not be
      cached, and whether any of them contradict the code's assumptions. Compatibility flags are versioned and some
      change behaviour on a date; a deployment pinned to an older compatibility date is running different code from
      the one the documentation describes.
- [ ] Check what runs on _every_ request even when the route needs none of it — a per-request cost paid by all traffic.
- [ ] **Check the test harness against the runtime** — see DC-2.14-01. An in-process request harness exercises the
      application and none of the platform: no isolate lifecycle, no I/O-context rule, no CPU or memory ceiling, no
      eviction, no real routing.

Deep checks:

- **DC-2.5-01 Write the platform-guarantee table before making any reliability claim.** `MUST`
  - **Question.** For each platform primitive the design depends on (execution unit, scheduling, timers, background
    work, storage, outbound connections, deployment semantics), what does the platform documentation actually guarantee,
    what does the code assume, and where is the gap?
  - **Why.** Reliability claims are cheap to make and impossible to falsify without this table. The gap between the
    documented guarantee and the code's assumption is the finding, and it is invisible in the code because the code
    reads as if the assumption were the guarantee.
  - **Look for.** "Background work", "it survives until the request ends", "the connection stays warm", "it runs on
    every deploy", "it is not evicted" — each stated as a fact with no citation to a guarantee.
  - **Evidence.** A four-column table: primitive, documented guarantee (with the page it came from), the code's
    assumption, the gap. Populated from the platform documentation, never from assumption.
  - **Failure modes.** A design that is correct in every individual line and unavailable in production.
  - **Verification.** For each guarantee the design depends on, name the test that would fail if it stopped holding. "The
    property is real" is not a defence; "no test reaches it" is the finding.
  - **Sources.** The platform's own limits, lifecycle and runtime-semantics pages for the deployment's current
    configuration.
  - **Freshness.** HIGH. These pages change more often than any other source in an audit; re-read before every run
    that depends on them, and re-read them during the re-research step (0.3).
- **DC-2.5-02 The scope of an in-memory control is a deployment decision, and the arithmetic is the deliverable.**
  `MUST`
  - **Question.** For every control whose state lives in memory (rate limiter, counter, cache, nonce, lock), what is the
    effective ceiling, expressed as `per-instance limit × live instances`, and which input sets the instance count?
  - **Why.** The limit a team believes it has and the limit the system enforces differ by the instance count, and the
    second factor is frequently set by a routing decision (which object identity a request goes to) or a performance
    flag (whether a client is pooled) — neither of which anyone connects to the control. A limiter can also be
    dramatically *more* restrictive than intended, which is an availability defect of the same shape.
  - **Look for.** The instance count: how many object identities exist, how they are named, and whether a name maps to
    one identity or many. The mode flag that decides whether a single object serves all traffic. Any control whose
    comment describes its scope as "per isolate" or "per instance" without checking what an instance is here.
  - **Evidence.** The arithmetic, with both factors sourced: one from the code, one from the deployment configuration.
    If the second factor is genuinely unobservable from the repository, say so and mark it an open question with a named
    owner input — do not report "adequate".
  - **Failure modes.** A login limiter that is one global bucket for the whole product; a counter whose per-key bound
    is multiplied by a thousand instances; an availability outage because a legitimate user is refused by another
    user's traffic.
  - **Verification.** Determine the instance count from the code and the deploy command, and assert the resulting
    ceiling against the control's stated intent. Add a guardrail that names the coupling, or record the coupling next to
    the control.
  - **Sources.** The platform's routing and object-identity documentation; the deployment configuration; the HTTP
    specification's rate-limit response fields.
  - **Freshness.** MEDIUM. The instance count is a project fact, not a platform fact; the platform's object model
    determines how it is computed.
- **DC-2.5-03 Caching a connection is legal in one scope and a hard error in another.** `MUST`
  - **Question.** For each long-lived I/O object: which scope holds it, what is that scope's lifetime, and what is the
    concrete failure when the same code runs outside that scope?
  - **Why.** On a stateless edge runtime, module scope is shared and there is no "between requests" moment in which an
    I/O operation may be started on behalf of one and resolved for another; the identical code is a hard runtime error
    there and a legal feature inside a single-threaded object. A check that says "never cache" is wrong; a check that
    says "cache it" is worse.
  - **Look for.** A module-level promise or client; a lazily initialised connection; a cache keyed on anything derived
    from request data; the same module imported by both the stateless entry point and the object entry point.
  - **Evidence.** The creation site, the scope, the lifetime, and the platform's documented rule for I/O in that scope.
  - **Failure modes.** A hard error on the first request after a cold start, or a connection used by two requests.
  - **Verification.** Name the two scopes the module is imported into, and state the behaviour in each. If it is
    imported into both, the lifetime question is answered by construction, not by inspection.
  - **Sources.** The platform's I/O and context-propagation documentation; the driver's own documentation for whether
    it treats the runtime as a serverless/FaaS environment.
  - **Freshness.** MEDIUM. The driver's environment detection is version-specific; verify against the shipped source.
- **DC-2.5-04 Idle-connection claims must be verified against the shipped driver, not against folklore.** `MUST`
  - **Question.** For every connection timeout and pool setting: what does the installed driver's own source and
    documentation say each option actually governs?
  - **Why.** These options are widely and confidently mis-described — including inside the project's own comments. A
    correct mitigation justified by a wrong explanation is a defect that gets "corrected" back, and the next reader
    draws the wrong conclusion about the risk.
  - **Look for.** Comments and docs that describe an option's mechanism; a mitigation whose rationale names a
    differently-behaving option; a claim that a timeout governs "idle sockets" that the driver documents as a
    connection-establishment timeout.
  - **Evidence.** The installed package's source for the option in question, and its own documentation. Cite both when
    they disagree.
  - **Failure modes.** A pool that never reaps idle sockets, or a connection establishment that hangs past the budget
    the team believed it had.
  - **Verification.** Read the option's implementation in the installed package and record what it does. Re-read on
    every minor release of the driver, since this class of option is exactly what changes silently.
  - **Sources.** The installed package's source and documentation for the pinned version.
  - **Freshness.** HIGH. Pin to the exact resolved version; re-verify on every minor. A claim about a driver's internals
    from memory is a guess.
- **DC-2.5-05 Middleware semantics: order is registration order, and the composition primitives have contracts.**
  `MUST`
  - **Question.** Does the audit know, from the framework's own documentation for the pinned version: what the
    composition primitive does with an error thrown downstream, whether a "not found" result is honoured on a mounted
    sub-application, and whether the request context is per-request or something wider?
  - **Why.** These are the three assumptions a handler pipeline is built on, and each has changed across major versions.
    A `try/catch` around the composition primitive is dead code if the primitive never throws; a not-found result
    discarded on a sub-router is a 404 that becomes a 200 somewhere unexpected; context assumed to be module-wide
    becomes a cross-request data leak the moment two values share a name.
  - **Look for.** Error handling wrapped around the composition call; not-found handling on a mounted router; a
    middleware storing into the request context and a reader assuming it is globally unique; a response mutated after
    the downstream handler has run.
  - **Evidence.** Each behaviour, from the framework's documentation, plus the code that depends on it.
  - **Failure modes.** A swallowed error that becomes a wrong status code; a cross-request value collision.
  - **Verification.** One test per assumption: throw downstream, return not-found from a sub-router, and run two
    requests with different context values.
  - **Sources.** The framework's middleware/routing documentation and migration guide for the pinned major.
  - **Freshness.** HIGH for a versioned framework; re-read the migration guide each major.

### 2.6 Database and data model

**Goal.** Establish that the queries the application actually issues are supported by the indexes and the data shapes
the database actually has, and that the data model survives concurrency.

**Read.** The data model and collection/index definitions; the migration script; the repositories and the query builders
they construct; the write paths and their read-modify-write shapes; the seed/import paths; anything that deletes,
expires or purges data.

**Measure.** Real query plans via the database's own plan output for the hot queries, against representative data with a
**skewed** distribution. Document sizes. Index count versus query count. Count of queries per single user action. Count
of collections with a reclamation policy and count with an actor to run it.

**Deliverable.** A table of query → plan → index used or not used → verdict; a list of missing/redundant/mis-ordered
indexes; a concurrency analysis of every read-modify-write path; and a **lifecycle-actor table** (below).

**Must not conclude without evidence.** Do not report a missing index from reading query code — get a plan. Do not
report "the index is unused" from a plan, or from a usage counter, without stating the window, the nodes and the
operations it covers. Seed enough data to make the plan meaningful, and say what you seeded.

#### The audit unit for scoping is the query, not the route

A per-route authorization audit finds the id-bearing endpoints. It cannot find the count, the aggregate, the search, the
counter or the audit query — and those are the same defect class. For **every** read the application issues, name the
clause that carries the caller's scope, and name the assertion that the scope's identifier belongs to the caller. The
route is where the caller is authenticated; the query is where the data is chosen. See DC-2.8-02.

#### Name the actor that executes a data lifecycle

Data that must eventually disappear — soft-deleted rows, expired sessions, audit trails, generated artefacts — is
usually described by a *mechanism*: an index, a flag, a purge function, a documented policy. A mechanism is not an
actor. For every such dataset, name **who or what removes it, and when it last ran**: a scheduled trigger, a
database-side expiry, an admin action, an operator runbook, or nobody.

- A purge function that no trigger reaches is a lifecycle that is modelled, documented, tested and never executed — and
  every mechanism-shaped check passes, because the mechanism is present.
- An append-only collection with no retention decision is simultaneously a data-protection finding and an
  unbounded-growth finding, and the second one is what actually takes the system down.
- Where the correct answer is "nobody, deliberately", record the acceptance and its reason, so the next reader does not
  read it as an oversight.

Checklist:

- [ ] Inventory collections, and for each, the indexes with their exact field order. Compound index order is the whole
      point: equality fields first, then sort fields, then range.
- [ ] Map every query the application issues to its supporting index. List queries with **no** supporting index.
- [ ] Get the real plan (with execution statistics) for each hot query, **per query shape** — a shape the planner
      selects between has more than one plan, and a plan captured once is not the plan production uses. Report: index
      chosen, documents examined, keys returned, sort stage, and whether the plan is a collection scan on a large
      collection.
- [ ] **Do not treat a plan as the production plan.** A captured plan bypasses the plan cache, and the server's planner
      can choose among strategies differently depending on version and configuration. State the server version the plan
      was taken on.
- [ ] Seed representative data before planning: enough documents for selectivity to be meaningful, and a **skewed**
      distribution (a few hot tenants/rows, a long tail). Uniform synthetic data produces a plan that does not match
      production. State the seed size and skew you used.
- [ ] Find **redundant** indexes: a prefix of another index, an index duplicating a unique constraint, an index on a
      field never queried. Each one costs write throughput and storage.
- [ ] Find indexes whose field order prevents their use for a query that exists. A compound index on (a, b) does not
      serve a query filtering only on b.
- [ ] Check for wildcard and text indexes: their cost, their limits, and whether queries rely on partial-match semantics
      the index does not provide.
- [ ] **Establish what the store considers "equal" and "in order", and from what.** A document store commonly
      compares strings byte-wise by default and offers a locale-aware comparison as an option that has to be set on the
      collection, the index, or the individual operation; a client compares strings with a locale-aware collator by
      default. The two disagree on case, accents and numeric-looking text, and the disagreement is invisible until a
      uniqueness constraint, a search or a paginated sort is built on it. Read the store's own comparison
      documentation — the same class of check as the validation layer's length units, applied to ordering. See
      DC-2.6-05.
- [ ] Hunt N+1: a loop containing a query; a serial chain of independent queries. Count queries for one representative
      user action, and compare with the theoretical minimum.
- [ ] Find independent queries executed serially that could run concurrently, and vice versa: queries sent in one round
      trip when the driver supports it.
- [ ] Check projections: are large fields (binary, rich text, blobs) fetched when not needed? An unprojected document
      turns a cheap read into an expensive one, and the field may be one the client never reads.
- [ ] Check pagination: offset pagination degrades linearly with depth and can be made to scan a large part of the
      collection; cursor pagination is stable under concurrent writes. Report the maximum page allowed and whether the
      offset value is bounded.
- [ ] Treat unbounded offset as both a performance defect and a denial-of-service shape: a caller can request a very
      deep page repeatedly.
- [ ] **A total count is a second query**, not free. Any list endpoint that returns a total alongside a page pays for
      it on every request, and on an append-only collection that count is the expensive one.
- [ ] Check aggregations: joins in a hot path, unbounded grouping, a sort after a stage that cannot use an index, and
      aggregations whose output can exceed the engine's per-document size limit. That limit binds **returned
      documents**, not the pipeline's intermediate state.
- [ ] Check for aggregation caching: a repeated pipeline that could be materialised or cached.
- [ ] Check document size: documents approaching the size limit, fields that grow without bound (activity logs, arrays
      appended per entity), and whether anything enforces a bound. Report the limit itself, from the engine's
      documentation, and the nesting-depth limit alongside it.
- [ ] Check atomicity: every read-modify-write that is not a single atomic operation is a race. For each, state the
      interleaving that loses data.
- [ ] Check optimistic concurrency: is there a version field, is it checked on write, and is the conflict translated
      into a domain-appropriate, **distinguishable** response? (See the API-design track for the status semantics.)
- [ ] Check transactions: correctness that requires one, and — equally important — the absence of transactions where
      multi-document writes can partially apply. **Detect transaction capability at runtime** rather than assuming it
      from configuration, and have a tested non-transactional path for the environments where it is unavailable. A
      deployment's database topology (standalone versus replica set) decides this, and it differs between production and
      the test environment more often than anyone realises.
- [ ] Check retryable writes: if the driver retries writes transparently, "the write happened" is no longer a single
      event, and the code's error handling must assume an unknown outcome rather than a failure.
- [ ] Check unique constraints: which invariants are enforced by the database versus only by application code, and which
      races the application check leaves open.
- [ ] **Decide the domain response for a constraint violation before adding the constraint.** A unique index turns a
      race into a database error; what the user sees (a conflict, a retry, an idempotent success) is a product decision,
      and the constraint must not be added ahead of it.
- [ ] Check soft delete: is it implemented consistently, do unique constraints account for it, and can a soft-deleted
      record be resurrected or referenced by new records? A soft-delete filter is a property of **every** access path:
      enumerate the paths that must carry it, and mark the ones that deliberately do not, with the reason in the code.
- [ ] **Build the lifecycle-actor table** described above. For every dataset that must be reclaimed, name the actor and
      when it last ran. A dataset with no actor is the finding, whatever the index situation.
- [ ] Check for injection and expensive-query abuse: unvalidated sort/field names, unbounded regular expressions,
      user-controlled aggregation stages, query operators taken from input. These are the classic data-layer denial of
      service, and in a JSON API the query is the interpreter — see the security track's interpreter list.
- [ ] Check search: minimum and maximum query length, whether an unbounded pattern can be sent, and whether the pattern
      is anchored and escaped. A pattern cost that grows with input length is a denial-of-service surface, and the
      database's own documentation describes the anchoring requirement.
- [ ] Check migrations: are they additive and idempotent? Do they run before the new code is live? Do they avoid
      destructive operations in the same release? Is a rollback path defined? A migration that must run before deploy and
      that the still-running old version cannot tolerate is an outage waiting for a release.
- [ ] Check that migrations are never run from the request path.
- [ ] Check connection/pool configuration against the platform's concurrency model, and whether pool exhaustion produces
      a clear error or a timeout. Report the two inputs to the pool size, or record that they are unmeasured.

Deep checks:

- **DC-2.6-01 "Unused index" is a claim about a window, a node set and a set of operations.** `MUST`
  - **Question.** Before calling an index unused, which usage statistic, over which window, on which nodes, covering
    which operations, and what does that statistic actually record?
  - **Why.** The documented exclusions are precise and each of them is a way to be wrong: the statistic is
    node-local, so a single node proves nothing about the cluster; it is driven by user operations, so a background job
    or an infrequent query makes an index look dead; and it resets on restart, on drop and on some collection changes.
  - **Look for.** "The index is unused" derived from a single node, from a short window, or from production traffic that
    excludes the operations that use it.
  - **Evidence.** The statistic, the window, the node coverage, and the operation set — or the finding is not stated.
  - **Failure modes.** Dropping an index that a monthly report depends on; keeping an index that a write-heavy
    collection pays for on every insert.
  - **Verification.** Take the statistic from every node over a window that covers the least frequent query, and state
    the operation coverage explicitly.
  - **Sources.** The database engine's own reference documentation for index statistics and for what they exclude.
  - **Freshness.** MEDIUM. Statistic names, reset behaviour and multi-planner defaults change between engine versions;
    record the engine version the measurement was taken on.
- **DC-2.6-02 A query timeout is a bound, not a defence.** `MUST`
  - **Question.** Which queries carry a per-query time bound, what happens when the bound expires, and what status does
    the caller receive? Then: is the expensive read itself bounded independently of the timeout?
  - **Why.** A time bound converts an unbounded query into a bounded wait that **the caller can trigger at will**. On an
    unauthenticated or cheaply-authenticated endpoint that is a denial-of-service amplifier, and the application-level
    control is a separate, deliberate limit on how expensive a read may be.
  - **Look for.** Time bounds applied uniformly and treated as the control; an expensive read reachable at a high rate;
    the timeout's error mapped to a generic failure rather than to a distinct, retryable status.
  - **Evidence.** The bound, the error path, the mapping, and the rate at which the endpoint can be called.
  - **Failure modes.** A cheap flood of requests that each burn the full budget, exhausting the concurrency the rest of
    the application needs.
  - **Verification.** Call the endpoint at its rate limit and measure the effect on an unrelated endpoint's latency.
  - **Sources.** The database engine's documentation for the bound; the platform's rate-limit response fields.
  - **Freshness.** LOW for the principle; re-check the option name against the driver's current documentation.
- **DC-2.6-03 Derived reads are the tenancy surface.** `MUST`
  - **Question.** For every read that produces a count, total, aggregate, search result, export, cached value, counter
    or audit entry, which clause carries the caller's scope?
  - **Why.** None of these addresses a record by id, so an id-bearing-route audit cannot see them, and a total count
    discloses a fact (how much a tenant has) that no record read would.
  - **Look for.** Count and total helpers; aggregation stages; regular-expression predicates; offset and limit helpers;
    caches and counters whose key omits the scope; audit queries keyed on an entity identifier alone; deferred work that
    re-resolves a scope after the response.
  - **Evidence.** For each repository, every distinct query construction and the field carrying scope.
  - **Failure modes.** A list whose total is global; an audit view returning another tenant's actor names; a counter
    whose key omits the scope, so two tenants collide on a sequence — a data-integrity defect as well as an
    authorization one.
  - **Verification.** Run each list/count/aggregate route as a second tenant and assert the response is empty-shaped, and
    that any total is zero rather than global.
  - **Sources.** The security track's reachability clause; the engine's query-predicate reference.
  - **Freshness.** LOW for the principle.
- **DC-2.6-04 Transactions and retryable writes change what "the write happened" means.** `CONTEXT-DEPENDENT`
  - **Question.** Does the deployment's database topology support the operations the code assumes, is that detected at
    runtime rather than assumed, and does the code handle an unknown outcome?
  - **Why.** Multi-document writes either need a transaction or need an explicit non-transactional path; and a driver
    that retries writes transparently means a failure may be a success that was not acknowledged. Both are invisible
    until the topology differs from the assumption — and the topology usually differs between production and the test
    environment.
  - **Look for.** A session opened before capability is checked; a catch path that assumes failure means the write did
    not happen; a multi-document write with no transaction and no compensating action; a test environment whose database
    is not the shape production uses.
  - **Evidence.** The capability check, the fallback path, and the tests that cover both branches.
  - **Failure modes.** A partial write in an environment without transaction support; a duplicate write after a retry.
  - **Verification.** Run the affected paths in an environment without transaction support and assert the fallback's
    behaviour, not just its absence of an error.
  - **Sources.** The engine's transaction and retryable-writes documentation; the driver's own session requirements.
  - **Freshness.** MEDIUM. Retryable writes require a replica set and their defaults have changed; verify against the
    installed driver and the deployed engine version.
- **DC-2.6-05 Equality and ordering are defaults, and the client holds a different one.** `MUST`
  - **Question.** For every field the application compares, sorts, deduplicates, searches or declares unique: which
    comparison rule does the **store** apply, which does the **client** apply, and are they the same rule?
  - **Why.** A document store's default string comparison is byte-wise, and a locale-aware comparison is an option
    that must be requested. A browser's default comparison is locale-aware. Neither side is wrong, and every property
    built on the comparison is only as strong as the weaker half: a unique constraint is unique under the store's
    rule, a dedupe is a silent no-op under the store's rule, a paginated sort can return a boundary the client
    re-orders, and a match found by the client is a miss on the server. There is a performance effect underneath the
    correctness one — a comparison specified on an operation that differs from the one on its index means the index
    cannot serve the string comparison at all.
  - **Look for.** A case- or accent-insensitive requirement implemented by lower-casing in application code rather
    than by the store's own comparison; a "unique" constraint the product believes is case-insensitive; a client-side
    re-sort of server-ordered data; a numeric-looking identifier ordered as text; a search whose predicate is built
    in the client; an operation that specifies a comparison rule while its index specifies a different one, or a
    single query that filters and sorts under two different rules.
  - **Evidence.** A three-column table: field · the store's comparison rule, with the page it came from · the
    client's comparison rule. Every row where the two differ is either a finding or a recorded decision with its
    reason.
  - **Failure modes.** Two records the product believes are the same; a uniqueness constraint that does not hold; a
    second page that repeats a row from the first or omits one; a row visible in the list and unreachable by search; a
    query that was indexed and now is not.
  - **Verification.** Insert a fixture whose case, accents or all-digits value the two rules order differently, and
    assert the intended behaviour at **both** ends. Then re-take the plan for the affected query: an operation whose
    comparison rule differs from its index's does not use that index, and the plan is the evidence.
  - **Sources.** The store engine's comparison and sort-order reference and its collation reference for the deployed
    version; the language runtime's internationalisation specification for the client's comparison.
  - **Freshness.** MEDIUM. The default comparison, the option's name, and which index types support it have all
    changed between engine versions, and the client's default is a product decision of the platform. Re-read both
    sides, and re-take the plan, before reporting a field as unaffected.

### 2.7 Input validation

**Goal.** Establish that every untrusted value is validated at the boundary, parsed strictly, and translated into error
messages that help without leaking.

**Read.** The schema definitions; the validation middleware and where it is mounted; every route's validation coverage;
the environment/binding parsing; the client code that consumes third-party API responses; the client's own validation,
when it has one (see 2.2.1).

**Measure.** Routes without a body schema, a path-param schema, or a query schema. Number of permissive schemas
(everything optional, permissive string types, unconstrained objects). Number of `parse` versus `safeParse` calls.
Number of ad-hoc manual validations in handlers. **The list of library behaviours the code relies on that a minor
release may change** (2.0.2, clause 2).

**Deliverable.** A coverage table per route, a list of over-permissive schemas, a list of unvalidated trust
boundaries, and the relied-upon-behaviour list.

**Must not conclude without evidence.** Do not claim a route is unvalidated without reading its registration and its
factory. Do not claim a schema is permissive without testing a value that should be rejected.

Checklist:

- [ ] Enumerate every untrusted input surface: path parameters, query parameters, body, headers, uploaded files,
      environment variables, third-party API responses, and the database-to-domain boundary. Handle each.
- [ ] **Mount validation once per route factory and prove it.** Path parameters are the most commonly unvalidated surface
      and the most directly exploitable, because they become query keys and object paths. Validate them centrally rather
      than per handler, and add a guardrail that fails when a new path parameter is added without a schema — a
      per-handler convention is a per-handler obligation, and a new handler is exactly where it is forgotten.
- [ ] Verify each query parameter is validated, including booleans, enums, numbers, and dates — not just presence.
- [ ] Verify each body has a schema and that the schema is the source of the handler's parameter type. A hand-written
      body type next to a schema is a second, unaudited definition.
- [ ] **The object schema is the mass-assignment allow-list.** By default a well-formed object schema strips unknown
      keys, which is a real, load-bearing protection: a body field the caller adds that the schema does not declare
      cannot reach the service. That protection is a property of the default, not of the code, so state it explicitly
      wherever it is relied upon, and check every place the schema is loosened (a pass-through mode, a catch-all record,
      a merged object built from several sources). The day someone reaches for the loosening form, the allow-list is
      gone and nothing fails.
- [ ] Check `parse` versus `safeParse`: a bare `parse` inside a handler (after middleware already validated) throws
      outside the error handler's expectations in some frameworks. Prefer safe parsing at every call site that is not a
      framework-integrated validator.
- [ ] **Establish what "equal" means on this boundary.** A store, a client and a case-folding helper in application
      code can each define equality differently, and a uniqueness rule, a duplicate check and a conflict response then
      disagree with one another. Name the comparison each side performs, and the rule the requirement is actually
      stated in (byte-wise, case-insensitive, accent-insensitive). Where they differ the requirement is ambiguous, not
      merely unimplemented — and the fix is a decision about which rule is intended, not a lower-casing call. See 2.6,
      DC-2.6-05.
- [ ] Check schema composition and reuse: is a shared field defined once, or repeated with drift? Divergence in reused
      fields is a common source of "the client and server disagree" bugs.
- [ ] Check for over-permissive schemas: everything optional, permissive string types where a format is known, unbounded
      arrays, `unknown` accepted where a schema exists. For each, test the value that should be rejected.
- [ ] **Check the unit of every length bound.** A library may count characters, code points, or byte sequences, and the
      three disagree for non-ASCII input; the sink on the other end may have its own unit (a password hash has one, a
      database field limit has another, a header has another). A bound expressed in one unit does not bound the others.
      Test with an astral-plane or combining input, not with ASCII.
- [ ] Check coercion: a schema that silently coerces types can turn a malformed request into a valid-looking one, and a
      numeric id into a string, or `""` into `0`. Decide per field whether coercion is intended, and check the
      boolean and numeric coercions specifically — they are the ones that turn absence into a value.
- [ ] Check defaults: a default applied by the schema is invisible to the client and appears in documentation nobody
      writes, and a default inside an optional wrapper changes whether the key is present at all. Defaults should be
      visible in the contract.
- [ ] Check transformations: a schema that transforms input is a second behaviour layer. Ensure the transformed shape is
      what the handler expects and what the type says.
- [ ] Check that validation errors are structured: field paths, codes, and messages a client can act on, in a stable
      envelope, with a **code the client branches on** rather than a message it matches.
- [ ] **Check the failure path of the validation framework itself.** The default body a validation middleware produces
      when its own hook is not configured is frequently the library's entire error object: every field path, every
      expected type, and the library's default message. That is an information-disclosure finding produced by omitting
      one argument. Verify what the shipped configuration actually returns.
- [ ] Check for error messages that leak internals: stack traces, driver messages, file paths, collection names,
      internal ids, or schema fragments in a 400.
- [ ] Check that validation cannot be bypassed by content-type or method tricks: a route that validates only when the
      content type is JSON.
- [ ] Check validation of **environment and configuration** at start-up rather than at first request. Per-request
      configuration validation is a per-request cost and a delayed failure.
- [ ] Check the database-to-domain boundary: documents are deserialised into domain objects. Is anything from the
      database trusted implicitly because "it is ours"? Old documents written by previous versions are exactly the
      untrusted population.
- [ ] Check third-party responses: parsed strictly, unknown fields ignored explicitly, and failures handled as failures
      rather than coerced into empty objects.
- [ ] Check that validation rules are covered by tests: one test per rejection path that matters, asserting the status
      code and the error shape. A schema with no rejection test is a hypothesis.
- [ ] **Replace the "duplicated client validation is acceptable" framing.** The rule survives and the framing does not.
      Two targets validating one field is a contract with a drift rate, and the two sides may now share a single schema
      through the standard-schema interop, or derive one from the other, at a cost that has fallen to near zero. The
      check is therefore: either the client and the server derive from one contract, or a **parity test** asserts the
      two agree, or the duplication is recorded as an accepted risk with a trigger. What is no longer acceptable is
      "duplication is fine" with no linkage and no test — the duplication is real and the drift is unguarded.
- [ ] Check whether the client form layer and the server schema agree on which fields exist, which are required, and
      what the bounds are. See 2.2.1.

Deep checks:

- **DC-2.7-01 Which library behaviours does this validation boundary depend on?** `MUST`
  - **Question.** List the library defaults and semantics this boundary relies on, and the release in which each could
    have changed.
  - **Why.** On a validation boundary the library's defaults **are** the contract, and defaults are what a version
    bump changes. None of this is visible in the code, and identical code under two resolved versions can enforce
    opposite rules. This is the single highest-value artefact a boundary audit produces, and it is cheap: a list.
  - **Look for.** Whether unknown keys are stripped or allowed. The unit a length bound counts in. Whether a default
    inside an optional wrapper changes key presence. Whether a claim in a token is verified or skipped when absent.
    Whether a failure is an exception, a returned value, or a resolved error field. Whether a header name is
    case-normalised. Whether a format string accepts what the project assumes.
  - **Evidence.** The list, with each entry marked: relied upon / not relied upon / unknown.
  - **Failure modes.** A bound that tightened between releases and now rejects legitimate input, or loosened and now
    accepts a payload the service cannot handle — with no code change to review.
  - **Verification.** For each entry, read the installed package's documentation and source for the resolved version and
    record what it actually does. Where documentation and source disagree, the source wins and the disagreement is the
    finding.
  - **Sources.** The library's own migration guide for the major, and its changelog for the minors since; the installed
    package's source.
  - **Freshness.** HIGH. This is the check that expires fastest and the one whose answer changes most. Re-run it on
    every dependency bump, and re-read the migration guide rather than the tutorial.
- **DC-2.7-02 The validation failure path is a security surface, and it is configured by omission.** `MUST`
  - **Question.** What does a validation failure return by default, and what does this deployment return? Is the
    failure path the same for every route?
  - **Why.** A framework-integrated validator's default failure body is frequently the library's full error structure,
    which is a schema disclosure: the field names, the expected types, the default messages. It is produced by leaving
    an argument out, so it survives review and reaches production.
  - **Look for.** A failure hook that is absent, or present on some routers and not others; a response body containing
    library error structures; a message that names a type the client is not supposed to know about.
  - **Evidence.** The actual response body from a rejected request, captured.
  - **Failure modes.** A 400 that tells an attacker the exact shape of the model, including which fields are optional.
  - **Verification.** Send a request that fails validation on every route group and compare the bodies; they should be
    the same shape and should not contain library internals.
  - **Sources.** The validator middleware's documentation for the pinned version; the schema library's error-shape
    documentation.
  - **Freshness.** HIGH. The default failure body is exactly the kind of behaviour that changes in a minor release.

### 2.8 Security

**Goal.** Find reachable, impactful security defects. **Reachability first**: before writing a finding, answer what an
attacker would have to do to reach the code, and what the impact is given this application's exposure. The three fields
— reachability, exploit scenario, impact — are defined in 2.0.4 and every item below inherits them.

**State the taxonomy the run is against.** A security audit run against an unnamed edition of a category list cannot
claim coverage, because the list changes and whole categories appear. Name the edition and the date in the report, and
map the findings to it. Note that several categories now sit **between** this playbook's tracks: mishandling of
exceptional conditions (failing open, missing parameters, error disclosure) is this playbook's error-handling track;
supply-chain failures include the pipeline and the artefact, not only the manifest; and the logging category's current
name points at **alerting**, which is an observability item and not a logging one. A framework-by-framework audit misses
exactly these.

**Read.** The whole trust boundary surface: routes, authn/authz, session/token handling, file handling, outbound
requests, secret handling, dependency manifest and lockfile, platform configuration, and deployment configuration.

**Measure.** Count of routes reachable without authentication. Count of authorisation checks that use a request-supplied
value as the authority. Count of authorisation checks that name the target they authorise. Dependency vulnerability
report from the package manager's own audit. Secrets scan of the working tree and of the history. **For every
in-memory control: `limit × instances`** (2.5, DC-2.5-02).

**Deliverable.** A findings list ordered by reachability × impact, each with a concrete exploit scenario; a table of
enforcing artefacts with their failure latency (2.0.3); and a separate list of the "checked and not applicable"
conclusions, each with its trigger.

**Must not conclude without evidence.** Do not report a vulnerability class in the abstract; report a location and a
scenario. For every "not applicable" conclusion, state the mechanism that makes it inapplicable **and the condition
that would change that** — "not applicable because the API is authenticated with a header bearer token and sets no
cookie, so no ambient credential exists for a third-party site to ride" is a finding in its own right; a bare "CSRF is
not applicable" is not.

Checklist — use as a checklist, but only report what you can reach:

- [ ] **Reachability pass first.** For each candidate: what is the attacker's position (anonymous internet user,
      authenticated user of the same tenant, authenticated user of a different tenant, holder of a leaked credential)?
      If the answer is "would require an already-critical compromise", the finding's severity is bounded by that.
- [ ] **The control must live server-side.** Any authorization or permission decision in client code is a UX affordance.
      Cross-check every client-side guard against a server-side assertion of the same rule (2.2, DC-2.2-05).
- [ ] **Broken access control / IDOR — enumerate both units.** For every id-bearing route, can user A read, change or
      delete user B's object? Test against a second identity, not against the code's intent. And then, separately, for
      every **query** that derives a count, list, aggregate, search, export, cache entry or audit record, name the clause
      that carries the caller's scope (DC-2.6-03). The second half is the half an id-based audit cannot reach.
- [ ] **Name the enforcing artefact for every authorization claim.** For each id-bearing route, name the assertion that
      resolves the target **and** the caller's membership of it, and the seam it lives in. A route with no named
      assertion is the finding. The seams fail differently: a middleware check cannot see the target because the target
      is not resolved yet, so it answers "may this caller use this endpoint"; a service-level assertion is the only
      place that can express "is this caller a member of this object"; repository scoping is the widest surface and the
      narrowest knowledge; a database constraint cannot express most relationship predicates.
- [ ] **Hunt the guard that silently no-ops.** A guard written `if (context) authorize(context)`, a required context
      whose fields are checked as an object rather than per field, a repository unavailable inside an authorization path
      treated as "skip the check", an exception during the assertion caught and turned into a continue. Each of these
      fails **open** and none of them throws. A guard is fail-closed only if its absent-input path is tested; the
      strongest form makes the unsafe call unrepresentable by requiring the context as a parameter.
- [ ] **Multi-tenant isolation.** Every tenant-scoped query resolves the tenant from the authenticated context, never
      from the request. Record the cross-tenant response as an **unconditional decision**, not a preference: what does a
      foreign-but-valid identifier return, and what does an identifier that does not exist return? They should be
      indistinguishable, and the test is a byte-level comparison of both responses. Two different leaks hide here —
      confirming that an object exists, and disclosing the authorization model (a message that names the required role
      enumerates the model). Refusing loudly in a log while returning little in the response is the correct shape; a 403
      that differs from the 404 is a free oracle.
- [ ] **Privilege escalation.** Can a user assign themselves a role, change a role's capabilities, elevate via a
      mass-assignment-style body, or act outside their membership? Check every body that accepts a role or permission
      field, and check that the schema's strip-by-default behaviour is what stops the rest.
- [ ] **Enumerate identities and enumerate roles separately.** Does any endpoint reveal whether an identity has an
      account, and does any reveal whether a role exists or what it may do? The fixes differ, and a timing difference is
      an oracle even when the message and status are identical — an unknown-account path that returns before doing the
      expensive work is measurably faster than a known-account path that does it.
- [ ] **Time is an input, and a distributed system has more than one clock.** For every expiry, lease, window, retry
      budget, rate-limit window and signed timestamp: which clock is compared against which, and does the comparison
      tolerate the offset between them? A specification may permit a small leeway for clock skew — permitting one is
      not applying one, and the code applies it or nobody does. Then check both directions a clock fails: a step
      forward expires live things early, a step backward holds them long past their intended life. Neither announces
      itself, and neither appears in a test that runs on one machine inside one second. See DC-2.8-07.
- [ ] **CSRF.** For cookie-authenticated state-changing requests: is there a token, a same-site policy, and/or an origin
      check? If none applies, state why and confirm the claim against the code — the usual reason is that the credential
      is not ambient. Record it as a negative with its trigger.
- [ ] **CORS is not an authorization control.** It is a browser mechanism that a non-browser client ignores. Check the
      allow-list, the credential setting and the preflight, and check that no decision depends on CORS having refused.
- [ ] **XSS and stored content.** Untrusted data interpolated into markup; user-controlled URLs in link or source
      attributes; user-controlled style or class attributes; error messages rendered as HTML. For stored rich text, see
      2.3.2: the question is the consumer inventory, not the editor.
- [ ] **The interpreter list, not the shell.** In a JSON API the reachable interpreters are the query and its operators,
      the response headers, the log sinks, the mail templates and the template engine — not the process shell. Enumerate
      the reachable ones and check each; "there is no shell here" is the reason the list was needed, not the end of the
      check.
- [ ] **SSRF.** Any URL or host taken from user input and fetched by the server; any webhook, import, image-proxy, or
      link-preview feature. Enumerate the outbound-call surface, treat deferred work as a second and differently-governed
      surface, and check the allow-list and redirect following. A negative here is earned by the set of outbound hosts
      being fixed; record that set and the trigger that would change it.
- [ ] **NoSQL / query injection.** User input reaching a query operator, a field name, or a JSON path. Check whether the
      driver or ORM treats request objects as query fragments, and whether any operator, projection or sort field is
      derived from input.
- [ ] **Path traversal and file handling.** Any filesystem path built from user input; file names, archive entries and
      template paths. Where the product accepts uploads: type, size and name handling, and whether the stored path is
      derived from user input. Where it does not, record the negative and its trigger rather than skipping the question.
- [ ] **Prototype pollution.** Deep-merge of request bodies into configuration objects; unchecked keys copied into
      object prototypes; a schema that copies unknown keys.
- [ ] **Open redirect.** Redirect targets from query parameters, validated against an allow-list.
- [ ] **Information disclosure.** Stack traces, verbose database errors, internal hostnames, identity enumeration
      through differing responses or timing, comments and source maps in production, directory listing, secrets in error
      payloads, and validation failures that return the schema (2.7, DC-2.7-02).
- [ ] **JWT and token handling.** Algorithm pinned; the algorithm accepted from the token, and header parameters such as
      key id or URL, never trusted from the token itself; expiry, issuer and audience checked; tokens not logged;
      revocation handled. **Check the claim-presence contract**: a verifier that skips a temporal check when the claim is
      absent means a token with no expiry is valid forever, with no error, and that contract lives in application code
      with nothing keeping it there. Also: a signed token is not an encrypted one, so the payload is a disclosure
      surface. And a token that cannot be revoked means the design must choose one of the substitutes — a short lifetime,
      a server-side session, or a denylist — and the "logout window" is that choice, not an oversight.
- [ ] **Credential storage and its compensating control.** Where a credential lives in web storage, the cross-origin
      constraint makes that a forced choice, and the offsetting control is part of the same decision: a restrictive
      content-security policy and a typed-DOM enforcement mechanism. State the storage decision and the offsetting
      control together, or record an explicit acceptance. A bearer token in web storage is not a cookie, so the
      cookie-oriented checks above do not cover it.
- [ ] **Brute force and abuse.** Rate limits on login, password reset, invitation and verification endpoints; lockout or
      backoff; whether the limit is per identity and per source; whether a limit can be bypassed by rotating identifiers.
      For each, do the `limit × instances` arithmetic (DC-2.5-02) and check the **key**: a limiter keyed on something the
      caller chooses is a limiter with no limit.
- [ ] **Per-cost limiting.** An endpoint whose side effects are priced by a third party must be limited per side effect,
      not per request. An application limiter does not bound a vendor's bill when the vendor's limit is per team.
- [ ] **Business-flow abuse.** A flow that is harmless one call at a time can be harmful in bulk (mass assignment of
      roles, rapid membership changes, repeated exports). Name the flow; there is no per-endpoint check for it.
- [ ] **Password storage.** The hash's silent input-length truncation, the unit of the length bound at each of its three
      authorities (the schema, the transport, the hash), the work factor chosen against **this** platform's CPU budget
      rather than a generic rule, the cost of a hash on an unauthenticated endpoint as a denial-of-service amplifier, and
      whether a rehash-on-login path exists (without it, raising the work factor is a no-op for exactly the population
      worth attacking offline). Report the work factor as a matrix of rounds × platform × measured cost, never as a bare
      number.
- [ ] **Reset tokens and other credentials.** They are credentials: single use, expiring, stored hashed, never logged,
      and invalidated on use.
- [ ] **Secrets: audit every surface a value can appear on, not one file.** Source, history, the client bundle, the
      build's injected values, the CI environment, CI logs, the secret store, the process environment, application logs,
      and error payloads. A source scan passes trivially; the reachable surfaces are usually the ones outside the source.
      Search for names, never print values; anything found in history requires **rotation**, not deletion.
- [ ] **Supply chain.** The condition list is wider than known vulnerabilities: install scripts (arbitrary code with the
      developer's credentials, and the manager's flag that disables them has its own cost), transitive dependency
      tracking, change management for the pipeline itself, an artefact inventory, and **patch latency** — which is what a
      floating version range on a security-critical dependency actually costs, and is measurable as the interval between
      an advisory and the lockfile that carries the fix.
- [ ] **Deployment configuration.** Unpinned automation steps, secrets available to untrusted pull-request runs, a
      platform route in fail-open mode, exposed development endpoints, public storage, an admin surface reachable from
      the internet, and any toggle that changes security posture without a deploy.
- [ ] **Security headers.** These are frequently a deployment artefact. A source search reporting "none" is a question
      about where they are set, not an absence — and if they are nowhere, that is the finding.
- [ ] **Write, for each finding, a one-sentence exploit scenario.** If you cannot write one, the finding is not ready.
- [ ] **Write, for each negative, its trigger.** A "not applicable" with no mechanism and no trigger is a hope, and it
      decays at the first feature that needs the missing capability.

Deep checks:

- **DC-2.8-01 Every security claim is classified by its enforcing artefact and its failure latency.** `MUST`
  - **Question.** For each security invariant the project claims, what enforces it, and how long after the invariant
    breaks does the enforcement notice — build, CI, runtime, or never?
  - **Why.** It converts "is access control enforced?" from an opinion into a table, and it separates the claim that
    has a test from the claim that has only prose. Prose-only claims are reported as unverified, which is often the
    most useful sentence in the report.
  - **Look for.** A rule stated in an entry document, a README, or a code comment with no corresponding test or type. A
    test that exists but has never been observed to fail. A guardrail on one side of a seam protecting a property on
    the other.
  - **Evidence.** For each invariant: the artefact, its tier, and — for a test — the observed failure when the invariant
    is removed.
  - **Failure modes.** "Access control is enforced" reported on the strength of reading the middleware, while the route
    that matters is covered by nothing and stays open until the next route is added without it.
  - **Verification.** Stub or remove each invariant in turn and record what goes red, at which stage. Nothing going red
    is the answer "never".
  - **Sources.** The security category's own prevention guidance, which in the current edition asks for functional
    access-control tests in the pipeline rather than for review.
  - **Freshness.** MEDIUM. The taxonomy's wording changes; the method does not.
- **DC-2.8-02 The authorization audit unit is the query, not the route.** `MUST`
  - **Question.** For every read, count, aggregate, search, cache lookup, counter and audit query: which clause carries
    the caller's scope, and which assertion proves that the scope's identifier belongs to the caller?
  - **Why.** A per-record audit finds the id-bearing endpoint and stops. The same defect — another tenant's data read
    without permission — also lives in a count without the scope predicate, a pipeline whose first stage omits it, an
    audit query keyed on the entity alone, and a counter whose key omits the tenant. None is addressable by an id, and
    none is reachable by an id-based test.
  - **Look for.** Count and total helpers; aggregation stages; regular-expression predicates; query objects assembled by
    assigning optional filters onto a base that must already carry scope; repository methods reachable from two services
    with different authorization requirements; a repository method whose base filter is supplied by the caller.
  - **Evidence.** Per repository, every distinct query construction and the field carrying scope — and, for each, the
    assertion upstream that the identifier belongs to the caller.
  - **Failure modes.** A list whose total is global; an audit view returning another tenant's actor names; a counter
    whose key omits the scope so two tenants collide.
  - **Verification.** Reach each query with a foreign identifier, from the service layer (not only from the route), and
    assert an empty-shaped result. Where the repository is only reachable through a service, add the repository-level
    guardrail rather than relying on the route table.
  - **Sources.** The API security category on object-level authorization, whose own wording is per _function_ rather
    than per entity; the authorization cheat sheet on validating permissions on every request.
  - **Freshness.** LOW for the principle; re-read the category's current wording, which has been revised between
    editions.
- **DC-2.8-03 Stored user content: audit the consumer inventory, not the writer.** `MUST`
  - **Question.** For every field holding user-supplied rich content: who renders it today, and who would render it if
    that capability were added (export, e-mail, notification, search index, public API)?
  - **Why.** Sanitisation applied by an editor protects the editor's own sink. The stored value is typically verbatim
    attacker input, and the reason it is safe is that **no other consumer exists** — a property of the codebase, not of
    the component, and one that evaporates with no change at the boundary the day a second consumer appears.
  - **Look for.** Renderers of the stored field; the sanitiser call sites; the write-time filtering (which should be
    absent); a guardrail that protects the write path while the property at risk is on the read path.
  - **Evidence.** The inventory, with the absent consumers named. "Verified: one renderer, and it sanitises" is a
    finding; so is "safe, because the editor sanitises" with no inventory.
  - **Failure modes.** Stored script injection the day a notification, an export or a search index renders the field
    without a sanitiser, with no code review at the boundary because nothing about the editor changed.
  - **Verification.** For each renderer, assert the sanitiser is applied at that sink. Add the absent consumers to the
    guardrail's fixture list so the first one to appear is a deliberate change.
  - **Sources.** The cross-site-scripting prevention cheat sheet; the editor's own sanitisation documentation, which
    states where the sanitiser runs and that the stored value is unmodified.
  - **Freshness.** MEDIUM. The editor's sanitiser set and its defaults change; re-read them when the version moves.
- **DC-2.8-04 Authorization controls live in one of four seams, and each fails differently.** `SHOULD`
  - **Question.** For each route, at which seam is the caller's relationship to the target asserted — request
    middleware, service, repository, or database constraint — and what is that seam's specific failure mode?
  - **Why.** The seams are not interchangeable and the choice determines what a mistake looks like. Middleware cannot see
    the target (it is not resolved yet), so it can only answer "may this caller use this endpoint". A service-level
    assertion is the only place that can express membership. Repository scoping is the widest surface and the narrowest
    knowledge. A database constraint cannot express most relationship predicates. A required parameter at the service
    seam is the only one of the four that turns the mistake into a compile error.
  - **Look for.** Optional context parameters on scoped methods; an assertion applied to the parent object but not to a
    nested entity reachable by a different route; a repository method with no scope parameter, reachable from two
    services with different requirements; a "cannot prove ownership" path that proceeds.
  - **Evidence.** Per method signature: is the context required or optional. Where the answer is "optional", what enforces
    it instead — and if nothing, that is the finding.
  - **Failure modes.** A guard that a new call site can simply omit, which is a defect waiting for the next feature.
  - **Verification.** For each seam, one test that omits each context field and asserts the refusal, plus a test that
    makes the assertion's own dependency fail and asserts the same.
  - **Sources.** The authorization cheat sheet on deny-by-default and on relationship-based over role-based checks; the
    API security category on object-level authorization.
  - **Freshness.** LOW for the principle.
- **DC-2.8-05 The rate limiter's effective ceiling is arithmetic, not configuration.** `MUST`
  - **Question.** For each limiter: `per-instance limit × live instances`, the key it counts on, and the input that sets
    the instance count. Then: what is a caller told when it is throttled?
  - **Why.** The two factors multiply, and the second one is usually set by a routing decision or a performance flag
    that nobody connected to the control. The result is routinely a limit far above what the team believes, and
    occasionally far below it — the second being an availability defect with the same shape.
  - **Look for.** In-memory counters; a key derived from something the caller controls; a comment describing the scope
    without checking what an instance is in this deployment; an endpoint whose side effects cost money and are limited
    per request rather than per effect.
  - **Evidence.** The arithmetic with both factors sourced, and the response fields a throttled client receives.
  - **Failure modes.** Credential stuffing that the limiter does not slow, or a legitimate user refused because another
    user's traffic consumed a shared bucket.
  - **Verification.** Determine the instance count (DC-2.5-02), then assert the effective ceiling against the control's
    stated intent, and check the throttled response carries the standard retry information.
  - **Sources.** The platform's rate-limiting documentation (its own limits, and how its own rate limiter counts); the
    HTTP specification's rate-limit fields; the abuse cheat sheet.
  - **Freshness.** MEDIUM. Plan limits and counting characteristics are product settings, not library versions.
- **DC-2.8-06 Secrets and data exposure are surface problems.** `MUST`
  - **Question.** For each secret and each piece of personal data: on which surfaces can it appear, and which of them
    are outside the source tree?
  - **Why.** A secret scan of the working tree passes trivially and proves almost nothing, because the reachable
    surfaces are usually elsewhere: a build-time injected value, a CI job's environment, a value interpolated into a
    logged URL, a response body, a mail template. Personal data is the same problem: the finding is a data-protection
    one only after the inventory exists.
  - **Look for.** Values injected at build time; secrets in the deployment job; personal data in logs; personal data
    returned by an endpoint that no client reads; personal data in an append-only collection with no retention decision.
  - **Evidence.** The per-surface table. Names only; never values.
  - **Failure modes.** A secret that is not in the repository and is nevertheless in the bundle, the CI log, or the
    error payload; personal data retained forever in an audit trail nobody decided to keep.
  - **Verification.** Search the built artefact and the pipeline's environment, not only the source. For personal data,
    compare the fields returned by each endpoint with the fields any client actually reads.
  - **Sources.** The secrets-management cheat sheet; the logging cheat sheet's guidance on what must not be logged.
  - **Freshness.** LOW for the principle.
- **DC-2.8-07 A distributed system has more than one clock, and "now" is a seam.** `SHOULD`
  - **Question.** For every time-derived decision — a credential's expiry, a lease, a rate-limit window, a cache
    entry's lifetime, a signed timestamp, a scheduled purge — name the clock on each side, the offset between them, and
    the tolerance the code applies. Then: is the expiry evaluated by the store that owns the record, or computed in the
    application before that store is reachable?
  - **Why.** Expiry claims are absolute timestamps, so verifying one compares two clocks; the specification that
    defines them allows the verifier a small leeway for exactly this, and applying that leeway is the code's job, not
    the library's. A lease held across a pause is held after it expired. An expiry evaluated against a clock that
    stepped forward retires a live record early and re-admits the work the record was suppressing. Both directions
    fail, neither throws, and neither appears in a suite that runs on one machine inside one second — which is why the
    class is invisible rather than rare.
  - **Look for.** A timestamp minted by one component and checked by another; an expiry, window or limit computed in
    application code rather than evaluated where the state lives; a tolerance that is either absent or unbounded; a
    schedule or purge decision that depends on a wall-clock boundary — an hour, a day, a month — in a time zone the
    code never names; a test that exercises a lease by waiting on real time, so it passes locally and races in
    production.
  - **Evidence.** A table: decision · the clock it is compared against · the offset assumption · the tolerance
    applied · what happens when the offset exceeds it. A row with no tolerance carries either a number or a recorded
    acceptance.
  - **Failure modes.** A credential that expires seconds after it was issued, on one node and not another; a lock held
    long past its lease by a paused process; a daily job that runs twice, or not at all, across a daylight-saving
    boundary; a signature rejected as issued in the future.
  - **Verification.** Move the clock. Put the issuing side forward and the verifying side backward by a plausible
    offset and assert the intended behaviour on both, then state what the code does **beyond** the offset you tested,
    because the test proves the tolerance you chose and nothing about the one you did not.
  - **Sources.** The specification that defines the claim or field you depend on, for its own wording on leeway and on
    the unit; the platform's documentation for whether it supplies a monotonic clock and what a suspended process can
    observe; the database's documentation for whether expiry is evaluated by the store or by the caller.
  - **Freshness.** MEDIUM. Skew tolerances, the claims that carry a timestamp, and the platform's clock behaviour each
    change independently of one another. Re-read the claim's definition and re-run the offset test whenever the
    verifier library, the token's issuer, or the deployment's topology changes.

### 2.9 Performance

**Goal.** Find the changes that produce the largest user-visible improvement per unit of risk. Every number states its
measurement method and its error.

**Read.** The hot request paths on both sides; the rendering path; the client's request graph; the caching layers; the
asset pipeline.

**Measure.** Server-side: per-route latency percentiles from the project's own timing facility, plus a controlled
measurement of the suspected hot path. Client-side: a profile of the heaviest page, the request waterfall from the
browser's own network tooling, and a count of requests per page.

**Deliverable.** A ranked list of performance findings, each with method, measurement, error bar, and the specific
change expected to move the number.

**Must not conclude without evidence.** Do not report a latency number without the method and the input. Do not
attribute a slow page to a specific function without a profile. Do not re-measure a number nobody is going to act on.

#### Use the platform's published numbers, and say where each came from

A judgement ("is this expensive?") becomes a check when it becomes a comparison. The platform and the specifications
publish thresholds: per-request CPU budgets and their averages, the CPU limits per plan, simultaneous outbound
connections, the subrequest ceiling, the startup budget, the document size and nesting-depth limits, the target-size and
contrast requirements, and the interaction-latency thresholds. Use them, and record the source and the date in a column
beside each one. **Where the project has no number of its own, the cell is a gap with a trigger** — the same treatment a
negative security result gets — not a number the auditor invented.

Two distinctions do most of the work here:

- **Field versus lab.** A number measured on the auditor's machine is a hypothesis; a number from real users is the
  decision input. The lab explains, the field decides. Never report a lab number as a user-facing one, and never
  conclude that a problem exists from a lab number alone.
- **Method includes the tool.** "Bundle size", "CPU throttling" and "memory" name three different measurements, and each
  instrument has a documented blind spot: a throttled profile is relative to the machine that produced it; a plan
  captured once is not the plan production uses; two heap snapshots is a leak observation, not a bloat or
  collection-pause observation.

Checklist — backend:

- [ ] **Write down the budget as named numbers**, not as a sentence: the CPU budget the platform enforces, the
      connection cost the design pays, and the topology that produces them. "Establish the latency budget" is not a
      check; the numbers are.
- [ ] Profile the hot path, or at minimum measure the suspected operation in isolation with a stated input size.
- [ ] Check CPU: expensive serialisation, regular expressions over large inputs, sorting in memory that the database
      could do, repeated encode/decode, synchronous crypto. On a CPU-metered runtime, distinguish work that burns the
      budget from waiting that does not.
- [ ] Check memory against the unit that actually bounds it: on a per-isolate runtime, memory is per isolate with a
      ceiling that kills the isolate, not per request. A "leak" here is a collection that grows within one instance's
      lifetime; a bounded, swept, attacker-keyed map is the correct shape, and its bound is a finding to verify.
- [ ] Distinguish **leak** (retained objects that should be gone), **bloat** (a working set larger than the workload
      needs) and **collection pauses** (allocation churn). Three observations, three instruments; reporting one as
      another produces a fix that does not move the number.
- [ ] Check the response path: serialisation cost, compression settings, and whether responses are built twice.
- [ ] Check network round trips and waterfalls server-side: serial awaits of independent operations. **Predicate:**
    the number of independent operations on one request path that are awaited in sequence rather than together — a
    trace, or the call graph with the branch points marked. "Looks serial" is not the finding; four round trips where
    two are independent is, and the count is what sizes the fix.
- [ ] Check for duplicate work: the same computation repeated per request that could be cached or precomputed;
      identical requests issued twice. Give this a predicate — the duplicate request count on one page load, or the
      number of identical queries per user action — or it produces a paragraph.
- [ ] Check request de-duplication: does the client's data layer cancel and share, or does every consumer open its own
      request for the same resource?
- [ ] Check polling: any interval that runs regardless of whether anyone is watching.
- [ ] Check caching at every layer available: HTTP cache headers, an application cache, a database-level cache, and the
      platform's edge cache. State which layers exist and which are unused, and check that the edge's cache key includes
      everything that varies the response (see the configuration track).
- [ ] Check cache invalidation: is there a correctness story for when cached data goes stale? A cache without an
      invalidation story is a data-loss bug with extra steps.
- [ ] Check cold start cost against the platform's startup budget, and whether it can be reduced by deferring
      initialisation. Schema construction and large data imports are the usual causes.
- [ ] **Check attribution**: the mechanism that attributes latency to its components must be readable by the tool the
      team will actually open. A correctly designed timing header that standard tooling does not parse makes the whole
      mechanism invisible while looking complete; verify the exact field name against the specification, not against
      habit.

Checklist — frontend:

- [ ] Measure the heaviest page: load, interaction latency, and where the time goes, from a profile rather than a
      feeling.
- [ ] **Decompose interaction latency before optimising it.** An interaction's total time is spent waiting for input,
      waiting for the main thread, and rendering. Only one of the three is usually the application's, and optimising the
      other two wastes the effort.
- [ ] Count network requests per page and identify duplicates (the same resource requested twice with different URLs).
- [ ] Find the waterfall: a request chain where each step waits for the previous one unnecessarily.
- [ ] Check for over-fetching: a list endpoint returning full entities where a summary would do — including fields no
      client reads.
- [ ] Check payload sizes: response bodies, initial JavaScript, CSS, images, fonts.
- [ ] Check large lists: is rendering windowed? The threshold is a measurement, and windowing is a trade (search,
      accessibility, print) rather than a fix.
- [ ] Check images: format, dimensions, lazy loading, responsive sources.
- [ ] Check fonts: subsetting, preloading, number of weights, layout shift caused by font loading.
- [ ] Check third-party scripts: count, size, main-thread blocking, and whether each is still needed.
- [ ] Check the render cost: layout thrash from interleaved reads and writes, expensive style recalculation, large DOM
      trees.
- [ ] Check whether the app renders content before its data arrives, and whether that is a deliberate choice (skeleton)
      or an accident.
- [ ] For every number: state the method, the input, the environment, and the error. A measurement without an error bar
      is an anecdote.

### 2.10 Bundle size

**Goal.** Establish what actually reaches the user's browser, why, and which of it is removable. Also establish how to
measure truthfully when the tool miscounts.

**Read.** The build configuration, especially code-splitting, optimisation, and budget settings; the entry points and
lazy boundaries; the shared/barrel files; the icon and asset imports; the files copied verbatim from the public tree.

**Measure.** The build's own size report, per entry point; the composition of the initial chunk versus lazy chunks; the
largest individual modules in each. Cross-check with an independent method (see below).

**Deliverable.** Three named numbers — initial JavaScript, emitted CSS, per-locale payload — plus a list of specific
removals with estimated effect.

**Must not conclude without evidence.** Do not report a size from a build summary whose reported figure you have not
verified measures the real initial payload.

Checklist:

- [ ] Produce the build's own size report and record the exact numbers, including the reported initial bundle.
- [ ] **Verify the reported figure measures the true initial bundle.** Budget checks are only meaningful if the summary
      reports the real initial payload rather than a pre-transform figure. Confirm against an independent method — serve
      the built output and sum what the browser actually downloads for the first route, including CSS, fonts and the
      runtime. If the two disagree, trust your own method and report the tool's discrepancy as a finding.
- [ ] **Attribute per entry point and per route, not per package.** A package that is large overall may contribute
      nothing to the first route; a route-level attribution is the number that drives a decision.
- [ ] **Include what is not in the bundle.** Files copied verbatim from the public tree (themes, translations, fonts)
      are runtime fetches, invisible to the bundle budget and governed by a cache policy set elsewhere. List them with
      their sizes, and check their fingerprinting and cache policy in the configuration track.
- [ ] List chunk composition: initial versus lazy, and what is in each.
- [ ] Identify the top contributors per chunk: which modules, which dependencies.
- [ ] Check tree shaking: are there side-effectful imports preventing elimination, and does the package declare its
      side effects honestly? A dependency that fails to declare them is not eliminated even when it is unused.
- [ ] Check barrel files: a re-export barrel forces the bundler to consider every module behind it. Wide barrels on a
      lazy boundary defeat code splitting.
- [ ] Check for duplicate package versions in the tree — two copies of the same library, typically one ESM and one CJS,
      or one pulled by a peer. Duplicates are pure weight.
- [ ] Check modules that cannot be tree-shaken and find a tree-shakeable equivalent where one exists. Report the
      replacement's API-surface risk rather than assuming the swap is free.
- [ ] Check the icon library: is the whole set imported, or only used icons, and is the registry narrowed to the icons
      the app uses? A single import of a large icon set is a common top contributor.
- [ ] Check date and utility libraries imported wholesale where a tree-shakeable alternative or a platform API exists.
- [ ] Check polyfills: are they needed for the declared browser support, and are they loaded globally?
- [ ] **Check emitted CSS for dead weight**, and estimate the dead fraction: utilities that compiled for a variant the
      project never emits, selectors a vendored layer brings with it, and rules no rendered state reaches. Dead CSS is
      invisible in the source and permanent in the payload.
- [ ] Check source maps in production: are they uploaded (good) or served publicly (leak)?
- [ ] **Fingerprinting and cache policy are one decision, in that order.** A stable-name asset may not carry a long
      lifetime, because a long lifetime on a stable name is a correctness bug when the content changes. A fingerprinted
      asset must carry one. Check both halves; a cache policy applied to an unfingerprinted path is the expensive error.
- [ ] Check the declared budget settings: do they measure the real thing? A budget on a miscounted number is a false
      sense of safety — a finding, not a tuning task.
- [ ] Rank the removal candidates by (bytes saved) ÷ (risk). Most audits find one or two dominant contributors; find
      them before listing a long tail.

### 2.11 Code quality

**Goal.** Find the code smells that predict future defects, and the dead weight that costs attention daily.

**Read.** The whole source tree, prioritising the largest and most-changed files. The lint configuration (to know what
is already covered, so you do not report it). The project's declared naming and structure conventions.

**Measure.** File and class size distribution. Count of TODO/FIXME/HACK comments. Count of unused exports (via the
build's tree-shaking analysis or an import-graph search). Count of unreferenced locale keys, files, and dependencies.
Duplicate-code detection where a tool is available.

**Deliverable.** A smell list grouped by type, with the _cost_ of each stated in terms of future change, not taste.

**Must not conclude without evidence.** Do not report a file as dead without proving no reference reaches it — including
dynamic references, string-based imports, test-only usage, and configuration-driven loading. Do not report a dependency
as unused without a check that includes dev-time, build-time, and test-time usage.

Checklist:

- [ ] Long method: over the project's threshold, or over roughly a screen of logic, with more than one reason to change.
- [ ] Long file/class: list the top offenders with line counts and the distinct responsibilities inside them.
- [ ] Feature envy: a unit that reaches into another unit's data more than its own.
- [ ] Shotgun surgery: a single conceptual change requiring edits in many files. List the files and the concept.
- [ ] Primitive obsession: strings/numbers standing in for domain concepts. See 2.4.
- [ ] Boolean-parameter hell: functions/methods with several boolean flags. List them and the invalid combinations they
      permit.
- [ ] Duplicated logic: the same non-trivial code in multiple places, especially where the copies have already drifted.
- [ ] **Duplication across a language boundary is a contract, not a smell.** The same rule implemented on the client and
      on the server is not duplication in the usual sense; it is two implementations of one contract, with a drift
      rate. Handle it in the validation track, with a parity test or a shared definition.
- [ ] Dead code: unreferenced functions, files, classes, branches, flags, and commented-out blocks. For each, state how
      you proved it is unreferenced. Remember tests may be the only remaining reference — see the traps section.
- [ ] Unused exports: exported symbols no other module imports.
- [ ] Unused files: files no import path reaches.
- [ ] Unused dependencies: manifest entries with no reference in source, config, scripts, or tests. Check the lockfile
      too, for transitive-only usage.
- [ ] Unused translations/locale keys: keys no template uses, and — separately — keys used in code but missing from the
      base locale file. Both are defects; the second is worse. See 2.3.1.
- [ ] Magic numbers and strings: values used inline where a named constant belongs. Rank by how many places repeat them.
- [ ] **Explanatory comments are audited as documentation.** A comment that states _why_ something is configured a certain
      way is a claim about a dependency's behaviour, and it decays into a lie. Verify each such claim against the
      installed source (2.0.2), and treat a comment that cites a file and a line as the most dangerous kind: it looks
      authoritative. See the pipeline track.
- [ ] Commented-out code: report it; ask whether it is a decision record (move it to the history or an issue) or a
      leftover.
- [ ] TODO/FIXME/HACK: list them with age if the history is available. An old TODO is an unowned defect.
- [ ] Naming inconsistency: is the convention followed? Check exported symbols, files, and test names. Note where
      conventions legitimately differ (test files, generated files) and do not report those.
- [ ] Error-style inconsistency: how failures are raised in one module versus another.
- [ ] Leaky abstraction: a caller mutating an object the callee owns, or depending on internal field order.
- [ ] Inconsistent error and empty-catch handling (see 2.12 — report there, not twice).
- [ ] Report smells with a _cost_, not a label: "changing X requires touching seven files" beats "long file". For the
      items the tracks mark `MAY`, either give the predicate or drop the item: a check that cannot fail produces a
      paragraph, not a finding.

### 2.12 Error handling

**Goal.** Establish that every failure is caught, classified, surfaced correctly to the user, and diagnosable from logs.

**Read.** All catch/throw/rescue sites; the error handler middleware; the error classes and their mapping; the
client-side interceptors and per-call error handling; the logging calls on error paths; **the error contract of every
outbound client and SDK** (below).

**Measure.** Count of empty or near-empty catches. Count of sites that log-and-continue versus log-and-throw. Count of
distinct error response shapes. Count of error classes that never get a distinct status code. **Count of outbound
calls whose result is awaited and never inspected.**

**Deliverable.** A per-error-class strategy table, a list of swallowed failures and mis-mapped statuses, and a table of
how each outbound integration's failure is observed.

**Must not conclude without evidence.** Do not report a swallowed error as harmless; find what the code does next. Do
not claim a missing status mapping without naming the error class and the status actually returned. Do not report a
failure as handled without showing the code that observes it.

Checklist:

- [ ] Inventory every catch site and classify: log-and-rethrow, log-and-return-fallback, convert-to-domain-error,
      swallow-and-continue, or swallow-and-return-null. The last two are findings.
- [ ] Find empty catches and bare `catch {}`. Even a deliberate ignore needs a comment saying why.
- [ ] Find swallowed errors where the code continues with partial state — the worst category, because the failure is
      invisible until much later.
- [ ] **The unreachable catch.** Counting catches is not enough. A client or SDK that reports failure as a _value_ rather
      than as an exception makes every `try/catch` around it dead code, and the catch you would find by counting is not
      empty — it is unreachable. For each outbound integration, answer: **how is a failure observed?** Exception,
      resolved error field, or status code? If the answer is "the call throws", verify it against the SDK's own
      documentation, because some clients resolve on failure by design and say so.
- [ ] **A timeout wrapper bounds the wait; it does not make a discarded result observable.** Check every place a
      deadline is imposed on an outbound call, and confirm the outcome is still inspected after the race.
- [ ] **A fallback that succeeds silently turns "not configured" into "done".** A no-op or console-logging fallback for a
      missing credential resolves successfully, so the user is told a message was sent when it was not. Check every
      fallback and decide its posture deliberately.
- [ ] **A timeout is a failure of unknown outcome, not a non-effect.** Work may have completed after the deadline. Check
      whether the operation is safe to repeat and whether the caller retries; where it is not, an idempotency key is
      the only defence.
- [ ] Check the error taxonomy: is there a base error with a stable code, message, and status? Or is each site inventing
      its own?
- [ ] Check status-code mapping per error class: not-found, conflict, unauthorised, forbidden, validation, rate-limited,
      upstream-failure, internal. Find classes that always collapse into a generic server error. A success status
      carrying an error body is also a finding: it breaks the property clients rely on to isolate a failure.
- [ ] Check the response format: one envelope, always. No handler-specific shapes, no HTML error pages from the API.
- [ ] **Fail closed on exceptional conditions.** A guard whose own dependency throws must not become a "proceed". Find
      every place an authorization or validation step is wrapped in a handler that continues on error, and decide each
      one's posture explicitly. This class of defect is a security finding wearing an error-handling costume, which is
      why a framework-by-framework security audit misses it.
- [ ] Check that expected failures (validation, not-found) are not logged at error level — it poisons the signal that
      makes real errors visible.
- [ ] Check that internal messages do not leak: user-facing message versus internal detail, with the detail going to
      logs and the summary going to the response.
- [ ] Check the client side: is every failure surfaced, or does the UI silently do nothing? Check both the global
      handler and the per-call handling, and check they do not double-report.
- [ ] Check retry logic: is it bounded, is the backoff exponential **with jitter**, and is it applied to failures that can
      succeed on retry? A retry against a non-idempotent operation duplicates writes, and backoff without jitter does
      not prevent a retry storm.
- [ ] Check timeout and cancellation propagation: does a timeout surface as a timeout, not as a generic failure? Does a
      cancelled request reach the server as a cancellation?
- [ ] Check correlation: can a user-supplied failure be tied to a server log line by an id? See 2.13.
- [ ] Check what ends up in the log for each error class, and whether it is enough to diagnose without exposing
      sensitive data.
- [ ] Check the interaction with rate limiting and auth: a rejected request must not be logged with the credential; a
      throttled response must carry retry information.
- [ ] Check the client's user-facing error message path: does a user see a useful message, or a raw exception string?
- [ ] Check that a failure in the _error handler itself_ (logging failure, serialisation failure) cannot cascade.

Deep check:

- **DC-2.12-01 For every outbound client, the error contract is part of the interface.** `MUST`
  - **Question.** For each outbound integration: does a failure arrive as an exception, as a resolved value carrying
    an error, or only as a status? What does the code do with the returned value, and how would a failure be noticed?
  - **Why.** Some clients **resolve** on an error status and return a result object with an error field, and their own
    documentation says not to use exception handling for them. Every `try/catch` around such a call is unreachable, so
    the codebase appears to handle failure and does not. Stacked on a resolving fallback and a client-side timeout, the
    end-to-end result is a success response, a message telling the user to check an inbox, and a log line nobody reads —
    three independent silent mechanisms on one path, none of which throws.
  - **Look for.** Awaited calls whose result is assigned to nothing, or inspected only for a success field; a timeout
    wrapper that races a timer around a call whose outcome is never checked; a fallback that returns success when a
    credential is absent; an SDK documented as resolving on failure.
  - **Evidence.** Per integration: the SDK's documented error contract, the call site, and the observation that makes a
    failure visible (or the absence of one).
  - **Failure modes.** A workflow that reports success while nothing was delivered, with no error anywhere to trace.
  - **Verification.** Force the remote call to fail — a non-routable host, a rejected key, a stubbed error response —
    and assert that the application surfaces a failure rather than a success. If it surfaces success, the check has
    found the defect.
  - **Sources.** The integration's own documentation for the pinned version, which usually states the error contract
    explicitly; the vendor's own guidance on whether to use exception handling.
  - **Freshness.** MEDIUM. The contract is documented and occasionally changed; re-read it when the version moves, and
    read the installed client rather than a blog post about it.

### 2.13 Observability

**Goal.** Answer: if production broke at 3 a.m., could this system be diagnosed from what it emits — and would anyone
have been told?

**Read.** The logging setup and its call sites; metrics/tracing instrumentation; health and readiness endpoints; **the
alerting configuration and the runbook each alert points at**; the correlation-id generation and propagation.

**Measure.** Count of log statements without a correlation id. Count of routes with latency instrumentation. Existence
and content of health/readiness endpoints. Count of distinct error codes logged. **Count of conditions that are logged
with no threshold and no named response.**

**Deliverable.** A diagnosability verdict per incident class, with the missing signal named, and a list of the
conditions that are logged but never acted on.

**Must not conclude without evidence.** Do not conclude an endpoint is healthy because it returns 200; check what it
actually asserts (liveness versus readiness versus dependency check). Do not conclude something is monitored because
it is logged; check that a threshold exists and that a named response follows.

Checklist:

- [ ] Are logs structured (machine-parseable) or free text? Free text is a finding for anything above small scale.
- [ ] Are levels used meaningfully, or is everything one level? Check specifically that expected failures are not
      error-level.
- [ ] Is there a request/correlation id generated at the edge, attached to every log line, returned in the response
      headers, and propagated to outbound calls?
- [ ] Is the correlation id exposed to the user (in the error response, a toast, a support reference)? An id nobody can
      quote is not diagnosable.
- [ ] **Is anything actually alerted on?** A log line with no threshold and no named response is not detection; it is
      storage. For each condition the system must catch (error rate, latency, queue depth, a failing background job, a
      failing integration), name the threshold, the alert, and the runbook step. The conditions that have a log line and
      no alert are the findings.
- [ ] **Know the platform's own error vocabulary.** An incident is either an application bug or the platform killing
      the instance, and the dashboard speaks the platform's codes. Without the vocabulary the two are indistinguishable
      in the logs, and the first hour of an incident is spent guessing which one you have.
- [ ] Are there latency metrics per route, and do they cover the slow path (database, upstream) not just the handler?
- [ ] Are error rates and counts available per route and per error class?
- [ ] Is there a histogram/percentile view, or only an average? An average hides the incidents.
- [ ] Are database query timings visible, including timeouts and slow-query counts?
- [ ] Do logs include what is needed to diagnose (route, status, duration, user/tenant identity in a non-sensitive
      form) and exclude what must not be there (credentials, tokens, full personal data)?
- [ ] Is sensitive data redacted centrally, or is redaction left to each call site? Central redaction is the only
      reliable kind; a per-call-site discipline is a finding.
- [ ] Health endpoint: does it check only that the process is alive, or also its dependencies? A readiness check that
      only checks liveness will route traffic to a worker that cannot serve it.
- [ ] **Readiness as the platform's stand-in for fail-fast.** Where there is no boot phase, a required secret or binding
      that is missing cannot fail at start-up; the achievable equivalent is a readiness contract that reports not-ready
      until the configuration is present. Check that it exists and that traffic stops.
- [ ] Are long-running and background work items observable (queue depth, last success, failure count)? Deferred work
      that fails silently is the hardest class to diagnose because nothing waits for it.
- [ ] Are third-party/upstream calls instrumented with timeout and error rates? See DC-2.12-01: an integration whose
      failure is unobservable cannot be instrumented either.
- [ ] Is there a trace or span propagation between the client, the server, and the database? Without it, a slow page
      cannot be attributed to a component.
- [ ] **Check the attribution mechanism is readable by standard tooling.** Verify the exact field name of any timing or
      trace header against the specification, and confirm a standard client surfaces it.
- [ ] Pick three plausible incident scenarios (a slow endpoint, a failing background job, a user-visible wrong result)
      and check whether each could be diagnosed from the emitted signals. Report the gaps found by walking the
      scenarios; this is far more reliable than checking features one by one.
- [ ] Check for log volume problems: a per-request debug log in a hot path is both a cost and a signal-destroyer. Check
      the platform's own per-request log cap, and whether the reliable sink is one you actually read.
- [ ] Check the retention and redaction of the observability data itself: an observability store holding personal data
      indefinitely is a data-protection finding that the observability track is the only place to see.

### 2.14 Testing

**Goal.** Establish what the test suite actually guarantees, and where the guarantees are illusions. Critical paths
without tests matter far more than a coverage percentage.

**Read.** The whole test tree and its layout; the test setup and helpers; the framework's testing rules as this project
documents them; the CI configuration for what runs and what is required.

**Measure.** Test count by area. Coverage per area, if measurable, and more importantly the _mapping_ of source modules
to test files. Count of skipped/todo tests. Count of tests that assert nothing. Count of mocks per test. Measured wall
time per suite.

**Deliverable.** A map of source area → test coverage quality, a list of critical paths with no coverage, a list of tests
that are tautological, over-mocked, or flaky, and — the item this track is really about — **a list of what the test
runner does not execute**.

**Must not conclude without evidence.** Do not report a test as vacuous without reading its assertions. Do not report
flakiness without repeated runs (and then state the run count and failure rate). Do not rely on a coverage percentage to
identify untested critical paths — map them manually.

#### Audit what the test runner does not execute

**This is the reframe that makes the rest of the track decidable.** A test harness is a second implementation of the
runtime, and it differs from production in ways the suite is silent about. Before judging coverage, write down what the
harness replaces:

- **The platform.** An in-process request harness runs the application with no runtime isolation, no request-lifecycle
  semantics, no I/O-context rule, no CPU or memory ceiling, no eviction, no real routing, and no real startup budget.
  Every platform claim the design makes is untested _by construction_, and no collaborator mock is involved.
- **The deployment configuration.** A variable the production deploy sets, and the test environment does not, produces
  two different systems under one green suite.
- **The database topology.** Standalone versus replica set, transaction support, retryable writes: the suite passes
  against a shape production does not have, and the difference is invisible because the code is identical.
- **The local development runtime**, where the vendor documents that its behaviour diverges from production.
- **The fallback path.** A code path guarded by a feature-detection branch is the branch the test environment takes, so
  the production branch is the one never executed.
- **The notification path.** A test that forces a render proves the render, not the notification; a test that ticks a
  timer proves the timer, not the code that would have set it.

For each substitution, state the property that is untested and the platform guarantee the design depends on. That table
is the deliverable, and it is what a "coverage" number cannot tell you.

Checklist:

- [ ] Inventory: how many tests, per area, what kind (unit, integration, contract, end-to-end), and how long each suite
      takes.
- [ ] Map every source module to its test file. Missing entries are the untested surface.
- [ ] **Build the harness-substitution table** described above, and add the suite's third-party service usage: a suite
      that cannot run offline is a suite that will not be run.
- [ ] Identify the critical paths (login, authorisation, quota or billing, data mutation, tenant isolation, the primary
      user journey) and check each has real coverage. Report these before any coverage number.
- [ ] Find tests with no assertions, or assertions that cannot fail (asserting a value the test itself just set).
- [ ] Find over-mocked tests: every collaborator mocked, so the test passes while the real integration is broken. Count
      mocks per test and list the worst offenders. Note the distinction: mocking a collaborator is normal; mocking the
      _runtime_ removes the property the test appears to cover.
- [ ] **Test the absent path.** For each guard, does a test omit the input the guard depends on and assert the refusal?
      A guard that fails open when its input is missing passes every ordinary test, because the caller prevents the case.
- [ ] Find tests that assert on implementation detail rather than behaviour. Give this a predicate or drop it: the test
      is whether the same behaviour is asserted through a different implementation. `MAY`
- [ ] Find tests that duplicate each other (the same behaviour asserted in three places) versus tests that duplicate
      production logic (the test re-implements the algorithm, so both are wrong together).
- [ ] Check test isolation: shared mutable state between tests, order dependence, real network/filesystem access.
- [ ] Check for real coverage of the _error_ paths: rejections, timeouts, conflicts, authorisation failures, and the
      validation framework's own failure path. Happy-path-only suites are the norm and hide the defects that hurt.
- [ ] Check authorisation coverage: is there a test that a lower-privileged user is refused? And that a user of another
      tenant is refused — at the **query**, not only at the route (DC-2.8-02)? One per guarded operation class, not one
      per route.
- [ ] Check boundary and edge coverage: empty, one, many, maximum, maximum+1, invalid characters, unicode, astral-plane
      input, very long strings, negative, zero.
- [ ] Check end-to-end coverage of real user journeys: sign-up, first value, core loop, and the paths a support ticket
      usually describes. Note the gap between what the e2e suite covers and what users do, and note that the e2e suite
      bootstraps its own services — a defect in that bootstrap is a defect in the gate.
- [ ] Check selector robustness: tests selecting by visible text, by generated class names, or by DOM position break on
      copy changes and on localisation. Recommend structural selectors.
- [ ] Check the framework's own test-runtime rules: async settling, timer installation order, forbidden change-detection
      calls, cleanup between tests. A suite that violates them is flaky under load even if it passes now. This is a
      **conditional** check: the rules differ per reactivity model and per runner, and the project's own testing notes
      are the authority.
- [ ] Find skipped/todo tests. A skip is an admission; a silent skip that auto-enables on a future run is a trap.
- [ ] Measure flakiness: run the suite more than once (bounded, with a time cap) and record the failure rate. A single
      green run proves nothing about a suite with timing sensitivity.
- [ ] Check the assertions around guardrail/invariant tests: do they fail when the invariant is broken, or do they
      merely exist? A guardrail that cannot fail is worse than none, because it is trusted. See 5.2.
- [ ] Check whether any guardrail is **two-way** (every declaration used, and every used name declared) and whether any
      protects a property or only a coupling. See 5.1.
- [ ] Check test data construction: is realistic data used, and does a test-only data builder mirror production
      invariants (or contradict them)?
- [ ] Check the cost of the suite: if it is slow, tests get skipped, and skipped tests are the ones that would have
      caught the incident.
- [ ] Check what the suite asserts about the thing it is named after. A test file called "authorization" that only
      checks the happy path is a name, not a guarantee.

Deep check:

- **DC-2.14-01 A test harness is a second implementation of the runtime, and the harness is the object of the audit.**
  `MUST`
  - **Question.** For the platform, the deployment configuration, the store's topology and the feature-detection
    branches this design depends on: what does the harness replace, and which property is therefore untested **by
    construction**?
  - **Why.** Mocking a collaborator is one substitution; replacing the runtime the design is written against is
    another, and the second is invisible because the suite is green. A harness that runs the application in-process
    has no isolation model, no lifecycle, no ceilings, no eviction and no real routing; paired with a store of a
    different topology, it has not tested the platform — it has tested the application's agreement with a second
    implementation of the platform. That agreement is the artefact most likely to rot silently, and nothing in the
    suite is watching it.
  - **Look for.** An in-process request call standing in for the real runtime; a local development runtime the vendor
    documents as divergent; a store in the test environment that is not the deployed topology; a feature-detection
    branch where the test environment always takes the fallback path, so the production branch is never executed; a
    test that forces a render or ticks a timer instead of asserting the notification path.
  - **Evidence.** The harness-substitution table: what is replaced · the property left untested · the platform
    guarantee the design depends on. One row per substitution, and a row with no guarantee behind it is not a
    substitution worth recording — drop it.
  - **Failure modes.** A design that is correct in every individual line and unavailable in production, reported as
    covered. The suite is trusted, which is what makes the substitution expensive rather than merely wrong.
  - **Verification.** For each guarantee the design depends on, name the test that would fail if it stopped holding.
    "The property is real" is not a defence; "no test reaches it" is the finding. Then decide per row whether the
    substitution is removable — a test that boots the real runtime is often cheap and is worth the time it takes to
    find out — or is a recorded, owned gap with the trigger that would close it.
  - **Sources.** The platform's own documentation on what its local development runtime does and does not reproduce;
    the engine's documentation on which behaviours differ by topology; the test runner's documentation for what it
    does not execute by construction.
  - **Freshness.** MEDIUM. The set of things a local runtime diverges on grows with each platform release, and vendors
    publish the divergence list themselves — that list is the thing to re-read, not the test file.

### 2.15 API design

**Goal.** Establish that the API is consistent, minimal, correctly versioned, and that the client and server actually
agree.

**Read.** The complete route table (method, path, body schema, response shape, status codes). The client API layer. The
authentication/authorisation story per route group. Any published contract, OpenAPI document, or typed client.

**Measure.** Count of routes deviating from the naming convention. Count of response shapes. Count of endpoints
returning more fields than any consumer reads (from the client's usage of the type). Count of round trips per user
action. Count of routes that accept a concurrency precondition, and of routes that do not.

**Deliverable.** A **client↔server contract table**: every client call matched to its route, with mismatches marked.

**Must not conclude without evidence.** Do not report a contract mismatch from type names; match the actual URL, method,
and body the client sends. Do not report "unused field" from the response type alone — check the client's reads.

Checklist:

- [ ] Build the full route table with method, path, body, response, and status codes.
- [ ] Check resource naming consistency: plural, hierarchical, no verbs in paths, consistent nesting depth.
- [ ] Check method semantics: safe and idempotent where they should be, partial where they should be, creation where it
      should be. Find methods that violate this.
- [ ] **Check that each status code carries the semantics the HTTP specification assigns it.** A generic success doing
      the work of a created, a generic client error doing the work of a conflict, and a server error doing the work of a
      precondition failure all break the property clients rely on. The check is the specification's semantics, not taste.
- [ ] **Check the error envelope is one shape with a machine-readable code**, declared in one place, and that the client
      branches on the code rather than on the message. Codes invented in two places are an implicit contract with no
      declaration, and they drift.
- [ ] **Check concurrency control on updates.** For each update endpoint: does it accept a precondition (a version, an
      entity tag, a last-modified value), does the write require it, and is the failure distinguishable (a precondition
      status rather than a generic conflict)? The lost-update problem has a named status in an existing specification;
      use it, and accept a project-defined mechanism as long as the failure is distinguishable. Where the mechanism is
      absent, the whole class of concurrent-write defects is unrepresented.
- [ ] Check pagination is uniform across list endpoints: same parameter names, same response envelope, same defaults,
      same maximum. Pagination, filtering and sorting are **one** contract, and a per-endpoint variant of any of the
      three is three contracts.
- [ ] Check filtering and sorting: is there a closed allow-list, or can a caller pass arbitrary fields? A permissive
      sort parameter is both a data-layer denial of service and an information-disclosure risk, and a permissive
      allow-list is a coupling to the storage schema.
- [ ] **Check that ordering is part of the pagination contract.** A sorted page needs a **total** order: every sort
      needs a tie-breaker and the tie-breaker has to be unique, or the boundary between two pages can repeat or skip a
      row under concurrent writes — which is a correctness defect wearing a pagination costume. Then check that one
      query's filter and sort are governed by the same comparison rule; an engine that permits a different rule for
      each is permitting the two halves of one query to disagree. See 2.6, DC-2.6-05.
- [ ] Check versioning: how are breaking changes handled? Is there a deprecation policy? Is the current version
      explicit? If the only client is a first-party application deployed in lockstep, record that as the compatibility
      promise and the trigger that would change it.
- [ ] Check idempotency: classify every mutating endpoint, and where a retry would duplicate an effect, say what
      protects it — an idempotency key with stored state, a natural idempotency in the operation, or a documented
      "never retry".
- [ ] **Build the client↔server contract table:** for each client method, the route it calls, the body it sends, the
      response it expects, and the mismatch if any. This is a **checklist item, not an optional deliverable**: an audit
      that skips it is invisibly incomplete, because the table's absence produces no finding at all. It is the
      deliverable that catches the bugs unit tests on either side miss.
- [ ] Check for fields the server returns that no client reads (data exposure) and fields the client needs that the
      server does not return (a round trip to get them).
- [ ] Check for round trips that a single endpoint could serve: the client fetching a list and then fetching details per
      item.
- [ ] Check for endpoints that exist only for the convenience of one screen and have no general shape.
- [ ] Check rate-limit and pagination defaults against what the client actually needs: a default page of 1 or a limit of
      20 where the UI shows 100 causes a real defect.
- [ ] Check auth: is authentication required by default, or opt-in per route? Opt-in fails open on the next route
      someone adds.
- [ ] Check for long-polling, streaming, or websocket endpoints and their behaviour under reconnect.
- [ ] Check content negotiation and media types; check that the API never returns HTML for a JSON route.
- [ ] Check the deprecation of any endpoint that is dead: is it used by anything external? If you cannot prove it is
      unused, it is not dead.

### 2.16 Styling and UI consistency

**Goal.** Establish that visual decisions are made once, in tokens, and applied consistently.

**Read.** The styling configuration and its ordering/precedence rules; the global stylesheet; the theme and token
definitions; a representative sample of component templates across the app; the styling framework's current
documentation for the pinned major (re-read it — 0.3).

**Measure.** Count of raw values (colours, spacing, radii, shadows, font sizes) in templates and styles. Count of
duplicated class-expression strings. Count of style rules that override library internals. Count of classes in templates
matching no rule. **Count of utilities compiled for a variant the project never emits.**

**Deliverable.** A list of token violations, duplicated utility clusters, overrides, and unreachable styles, plus the
dead-CSS estimate.

**Must not conclude without evidence.** Do not report an "unused" class without checking how sources are detected for
this styling framework and whether the class is produced dynamically.

Checklist:

- [ ] **Source detection is textual, and it is the whole mechanism.** A utility is emitted because a class name appears
      as text somewhere the scanner reads. Establish the detection root, the explicit source declarations, and the ignore
      rules that can silently drop a directory — then verify that a class the project depends on is inside the detected
      set. A vendored tree outside the detection root is invisible to the compiler and to this audit.
- [ ] Find dynamically-computed class names: strings built from variables or concatenation. They survive no tooling —
      not detection, not linting, not autocomplete, not theme switching. **This check lives here, not in the
      design-system track.** Check the security angle too: a class name derived from user input is a style-injection
      surface, and it is a defence-in-depth question unless the name reaches a raw attribute.
- [ ] Find duplicated utility class strings repeated across templates. A class string repeated ten times is ten
      opportunities to be inconsistent; extract it to a component class or a token.
- [ ] Check for raw values where a token exists: hex colours, magic numbers, hard-coded z-index, hard-coded breakpoints.
- [ ] Check z-index: is there a scale? Arbitrary values are how overlays end up behind modals.
- [ ] Check spacing: is there a spacing scale, and do components stick to it?
- [ ] Check typography: heading levels, sizes, and weights from the scale; any inline style setting a font size.
- [ ] **Check that the theme is two systems reconciled, or one.** A styling framework has its own token layer; the project
      may have another. Verify the project's tokens are consumed rather than shadowed, and that a theme swap reaches every
      consumer.
- [ ] **Ask how dark mode is actually achieved, and compare it with the variant mechanism the framework assumes.** A
      variant compiled against a class the project never emits produces utilities that are permanently dead and a source
      of confusion; the absence of that class, with utilities present in the output, is measurable evidence.
- [ ] Check layers: the cascade layer model decides precedence, and **unlayered CSS wins over layered CSS** regardless
      of specificity. Unlayered overrides are invisible to a reader who checks specificity and does not check layers.
- [ ] Check overrides of library components: deep selectors, `!important`, high-specificity rules. Each is a coupling
      that a library upgrade breaks.
- [ ] Check for CSS leakage: global element selectors, unscoped rules, global resets reaching into component internals.
- [ ] Check unused styles: rules the build reports as unused, and template classes with no matching rule. A broad
      safelist hides genuinely unused styles — check what the safelist contains and why.
- [ ] Check the stylesheet ordering: do layer declarations guarantee a deterministic precedence, or does the result
      depend on import order?
- [ ] **Estimate the dead CSS fraction** in the emitted output: utilities for variants never emitted, selectors a vendored
      layer brings with it, rules no rendered state reaches. It is invisible in the source and permanent in the payload.
- [ ] Check responsive behaviour: breakpoints used consistently, layouts that break at narrow widths, content that
      overflows.
- [ ] Check reduced-motion handling: are animations disabled when the user requests it? Find animation without a
      reduced-motion path.
- [ ] Check theme coverage: which components hard-code a colour and therefore ignore the theme.
- [ ] Check print styles where relevant.
- [ ] Check for inline styles in templates (they defeat the token system and detection).
- [ ] Check consistency of the same idea across screens: a "card" that is a card in one place and a bordered box in
      another. Inconsistency here is what makes a product feel unfinished.

### 2.17 Accessibility

**Goal.** Establish that the product is operable by keyboard and by assistive technology, and that it does not rely on
assumptions about contrast that were never measured.

**Read.** Interactive components and their templates; the routing/shell structure; global styles including focus styles;
the form components and their error/label handling; the modal/dialog implementations; the motion and drag surfaces; the
localised strings and the longest locale.

**Measure.** Count of interactive elements with no accessible name. Count of non-interactive elements with a click
handler. Count of images without alt text. Count of form inputs without an associated label. Count of focus traps and
their correctness. The computed contrast ratios, per rendered pair, across the theme set.

**Deliverable.** A per-pattern list of defects with the affected component and the keyboard path that fails, plus the
residual manual checklist.

**Must not conclude without evidence.** Do not report a contrast failure from reading hex values — compute the ratio for
the pair as rendered. Do not report a missing keyboard path without trying it. Do not report a conformance claim from a
scanner's output.

#### Anchor the version, and split automated from manual

An accessibility audit without a version anchor cannot make a conformance claim, because criteria are added and the
newest ones are largely invisible to automated tooling. State the version and the level the run is measured against,
and use the tool's own rule table to split the work: most rule sets mark each rule as either an automatic failure or a
"needs review" item, and carry the criterion identifier, which makes the automated/manual boundary a lookup rather than
a judgement. Report the automatic results and the manual list separately, and never let a green scan stand as a
conformance claim: a score is not a conformance claim, and a scan's blind spots are a named list, not a general caveat.

The manual list is short, decidable, and the same every run: the pointer-only interactions, the focus management on open
and close, the announcements for asynchronous updates, the reflow at high zoom and in the longest locale, the
single-pointer alternatives for dragging, and the rich-text editor's own model.

Checklist:

- [ ] State the specification version and the conformance level the run is measured against, and whether the product
      claims conformance at all.
- [ ] Run the project's own scanner, report the rule count and the pass rate, and produce the manual list from the
      tool's "needs review" set.
- [ ] Name the blind spots for this application specifically: what the scanner cannot see here, and why.
- [ ] Semantic elements: is structure expressed with the right elements (`button` for actions, `a` for navigation,
      headings in order, lists for lists), or with generic containers plus roles?
- [ ] Every pointer-only interaction must have a keyboard equivalent — and, where a specification criterion requires
      it, a **single-pointer** alternative that does not depend on dragging. A keyboard equivalent alone is not
      sufficient for the dragging criteria, and a board built on drag-and-drop is exactly where this is missed.
- [ ] Focus management: is focus moved into a dialog when it opens, trapped while open, and returned to the trigger when
      it closes? Find dialogs that do not.
- [ ] Focus visibility: is there a visible focus indicator, and is it suppressed anywhere?
- [ ] Tab order: does it follow the visual order anywhere? Check for positive tabindex values.
- [ ] Skip link: is there a mechanism to skip repeated navigation?
- [ ] ARIA correctness: roles that match behaviour, states that are updated, and no ARIA that contradicts the native
      semantics. A role supplies no keyboard behaviour — the author does.
- [ ] Labels: every input has a programmatic label; every icon-only control has an accessible name; a tooltip is a
      description, never the only name. Extend the rule: any element whose role implies a name must have one.
- [ ] Form errors: the error message is associated with the field, and invalid fields are marked programmatically. See
      2.2.1 for the client form layer's own gap.
- [ ] Live regions for asynchronous updates: results count, save confirmation, error toasts — announced, not silent.
- [ ] Dialogs and popovers: focus trap, escape to close, correct role and labelling, and whether the underlying content
      is hidden from assistive technology. Check where the overlay renders (a portal is outside the component tree).
- [ ] **Measure contrast for the rendered pair**, not for two hex values: text against its actual background including
      disabled, muted and hover states, and across every theme the product ships. Where the theme set is large, sample
      deliberately and say what you sampled — an unmeasured theme set is a gap, not a pass.
- [ ] Check the target-size minimums for interactive controls, and the spacing exception where one is claimed.
- [ ] Images: meaningful images have alt text; decorative images are marked decorative; images that convey data have a
      text alternative.
- [ ] Loading, empty, and error states: are they announced? Is a spinner the only feedback? Is an empty state
      distinguishable from a loading state?
- [ ] Landmarks and headings: the page has a main landmark and exactly one top-level heading; the heading outline is
      meaningful.
- [ ] Document language is declared; the page title is unique per route and is a value, not a literal where the product
      is localised. "Descriptive" is a judgement; uniqueness is measurable.
- [ ] **Client-side routing manages focus, title and outline per navigation.** A single-page application replaces the
      view without the browser's default behaviours, so all three are the application's job.
- [ ] Reduced motion: animation, transitions, and parallax have a reduced-motion path driven by the preference, not by a
      hard-coded disable.
- [ ] Text zoom and reflow: the layout survives high zoom and a narrow viewport without horizontal scrolling or content
      loss — and survives the **longest** locale, which is where a translated interface actually breaks.
- [ ] Timeouts and auto-dismiss: a message that disappears is unavailable to a screen-reader user or a slow reader.
- [ ] Drag-and-drop operations: is there a keyboard alternative, and a single-pointer one, or is the feature
      pointer-only?
- [ ] Rich-text editor: check the toolbar's names, the value's role and label, the keyboard model, and the plain text
      exposed for the value. An editor has no accessible default. See 2.3.2.
- [ ] **Check the design system's accessibility before blaming the application** — and check it per usage, because a
      headless primitive's accessibility is a contract the consumer satisfies or does not (2.3).
- [ ] Decide which findings are **statically decidable** and therefore belong in a guardrail: a missing accessible name
      on an icon-only control, a page with two top-level headings, a page route with no title. Those are the
      accessibility findings a build should fail on, and they are the ones a scanner reports reliably.
- [ ] Where a scan is run at all, check it runs in the pipeline rather than once by hand, and that it is wired into the
      blocking gate rather than reported.

### 2.18 Configuration and environments

**Goal.** Establish that configuration is complete, validated at start-up, environment-appropriate, and free of hardcoded
environment values.

**Read.** All configuration files and their per-environment variants; the deployment/platform configuration; the
environment variable reads and their defaults; the start-up sequence; the client's build-time configuration.

**Measure.** Count of environment variables read; count with defaults; count read at start-up versus per request; count
of hardcoded URLs/hosts/paths in source. Count of duplicated values across environments. **Count of values injected at
build time, and where the injector is.** Count of runtime-fetched assets with no cache policy.

**Deliverable.** A configuration inventory (variable, where set, where read, default, secret or not) and a defect list.

**Must not conclude without evidence.** Do not report a missing environment variable without checking every
environment's configuration, including the platform's dashboard-driven configuration. Do not report a configured default
without checking the deploy command, which is what actually sets it.

Checklist:

- [ ] Inventory every environment variable the application reads: name, where it is read, its default, whether it is a
      secret, and which environments set it.
- [ ] Check for missing variables across environments — a variable set in one environment and absent in another is the
      most common environment-specific failure.
- [ ] **The deployed value of a mode variable is a deployment fact.** When a variable selects a topology, a pool size, a
      security posture or a limit, read the deploy command and the platform configuration and reconcile every prose
      statement of its default — the entry document, the configuration file's comment, the code comment — against it.
      This is a repeated finding in well-run projects: the code is right, the documentation is stale, and the
      documentation is what the next reader trusts.
- [ ] Check that secrets are secrets: not defaulted to a real value, not logged, not in the repository, not in the client
      bundle, and not in the build's injected values. **Never print the value; report only the name and where it was
      found.**
- [ ] Check configuration is validated at start-up, not at first use. On a platform with no boot phase, the equivalent is
      a readiness contract (2.13).
- [ ] Check defaults: is a default appropriate for production? A development default (localhost URL, permissive origin
      list, verbose errors, debug mode) that survives into production is a finding.
- [ ] Check debug/development mode cannot be enabled in production by an accident of configuration.
- [ ] **The cross-origin pair is one decision.** The client's base URL and the server's allowed-origin list are two
      configurations that must agree, and neither can be verified alone. Produce both lists and reconcile them. A
      mismatch is an application that cannot call its own API, and the failure appears only in the browser.
- [ ] Check API URLs: hardcoded hostnames in source are a finding; the build-time injection must be the single source.
- [ ] **Check the fingerprint/cache-policy pair for every runtime-fetched asset** (2.10): theme stylesheets, translation
      files, fonts. An asset with a stable name must not carry a long lifetime; an asset with a fingerprint must. A
      policy file that no build step copies is a policy that does not exist — check that the deployment actually ships it.
- [ ] Check the edge cache key: does it include everything that varies the response (host, path, query, headers the
      response depends on)? A key missing a variant is a cross-user data leak, not a performance setting.
- [ ] Check duplicated configuration: the same value expressed in two places (a file and a platform binding), which will
      drift.
- [ ] Check feature flags: what they are, who can read them, whether they are server- or client-side, and whether a flag
      can be toggled without a deploy. Undocumented flags become permanent.
- [ ] Check the platform configuration per environment: limits, bindings, observability, routes, compatibility flags.
- [ ] **Check whether a shared package's build output is fresh.** A contract consumed by two build targets is two
      contracts unless one artefact feeds both, and a stale compiled output that still resolves is a contract the sources
      no longer describe. Nothing catches this unless something asserts it.
- [ ] Check the local development setup: how a new developer starts the system, and whether the documented steps match
      reality — including the divergences the platform itself documents between local and production. Missing secrets
      documentation is a common failure.
- [ ] Check that configuration is typed where the language allows it, so a typo in a variable name fails at start-up.
- [ ] Check for values that differ between development and production in ways that change behaviour (a permissive
      validation schema, a disabled rate limit, a wider origin list, a different client-lifecycle mode).
- [ ] Check that the production build does not embed development tooling or verbose diagnostics.

### 2.19 Dependencies

**Goal.** Establish what the project depends on, what that costs, and what is risky.

**Read.** The dependency manifests across every workspace/package; the lockfile; the build and tooling configuration;
the CI workflow files; the registry configuration.

**Measure.** The package manager's own audit report. Count of direct vs transitive dependencies. Count of packages with
install scripts. Number of packages that duplicate another at a different version. Total installed size. Number of
packages last released a long time ago. **Measured patch latency** for the dependencies on a security path.

**Deliverable.** A dependency inventory with the notable rows flagged: vulnerable, unused, duplicated, oversized,
unmaintained, licence-relevant, **and the interval between an advisory and the lockfile that carries the fix**.

**Must not conclude without evidence.** Do not report a vulnerability without the advisory identifier and the affected
version range. Do not report a dependency as unused without checking config files, scripts, and tests — many are used
only by tooling.

#### Three decisions, not one

The dependency question resolves into three separate decisions, and conflating them produces both false positives and
misses:

1. **The manifest range** — what the manifest permits. This is a *latency* decision, not an install-integrity one: with
   a committed lockfile and a frozen install command, the install is fixed, and what the range really controls is how
   quickly a security fix can land. **Measure the latency** (interval from advisory to updated lockfile) rather than
   arguing about the range.
2. **The lockfile resolution** — what bytes were resolved. This is an *integrity* decision: the lockfile pins which
   bytes, and it does **not** pin who published them or from which registry. Say both things; a lockfile is routinely
   described as if it provided provenance, and it does not.
3. **The install command** — what runs at install. A flag that disables install scripts removes arbitrary code
   execution with the developer's credentials, and also skips the native builds some packages need. Both halves of that
   trade belong in the finding.

Checklist:

- [ ] Run the package manager's audit command (with a time cap) and record the report. Check whether it was ever run in
      CI.
- [ ] For each advisory, produce the quadruple: identifier, affected range, **reachability** in this codebase, and the
      **scope** of the fix. Reachability turns a critical into a non-finding; do the check rather than assuming.
- [ ] **Measure patch latency** for the dependencies on a security path: the interval between an advisory's publication
      and the lockfile carrying the fix. This is the number that justifies the pinning decision, and it is the number
      nobody has.
- [ ] List direct dependencies that are unused: no import in source, no reference in config, scripts, or tests.
- [ ] List duplicated packages (the same name at multiple versions in the tree) and the reason each is pulled in.
- [ ] List oversized packages by installed size, and the largest individual modules inside them.
- [ ] Check licences against whatever policy the project declares; flag unknown, copyleft, or conflicting licences.
- [ ] Check for unmaintained packages (no release in a long time, archived, or with an open deprecation notice).
- [ ] **Inventory the install scripts**: which packages run code at install, and is that acceptable for this project?
      The answer is a decision with a cost, not a yes/no.
- [ ] Check the registry host for every resolved entry in the lockfile, and check for unscoped names, which are a
      standing dependency-confusion exposure. Where the product publishes no first-party packages, record that as a
      negative with its trigger.
- [ ] Check for packages replaceable by platform APIs (a date library, a deep-clone library, a utility library where the
      platform now has the feature). Report the API-surface risk of the replacement.
- [ ] Check for a package that duplicates a platform or another dependency's functionality.
- [ ] Check the dependency manager: is it consistent across the workspace? Mixed managers produce two lockfiles and two
      truths.
- [ ] Check lockfile integrity: is it committed, is it in sync with the manifests, and is there more than one?
- [ ] **Check for phantom dependencies**: a module that resolves at build time but is not declared by the package that
      imports it. It works until the tree changes, and it is invisible until then.
- [ ] Check the supply chain of the automation itself: unpinned steps, a job that holds secrets while building, and
      least-privilege permissions per job. See 2.21.
- [ ] **Should this dependency exist at all?** For each large or security-critical one, the decision should have a
      recorded reason. `MAY`
- [ ] Check whether the pipeline's own duration is a supply-chain trade: a slow gate gets bypassed, and a bypassed gate
      is a supply-chain failure with extra steps.

### 2.20 Git and repository hygiene

**Goal.** Establish that the repository's contents, history, and configuration are what they should be.

**Read.** The ignore rules; the tracked file list; the attributes configuration; the history summary (authors, branches,
recent commit shapes); the hook configuration.

**Measure.** Count and size of tracked generated files. Largest tracked files. Count of files that should be ignored and
are not, and vice versa. Commit-message quality sample. Number of binaries in the index.

**Deliverable.** A hygiene defect list, plus an explicit statement about secrets in history (names only, never values).

**Must not conclude without evidence.** Do not report a secret in history by printing it; report the commit reference
and the variable/key name, and let the owner handle rotation. Do not report a large file without its size and its
tracking status.

Checklist:

- [ ] Read the ignore rules and check they cover: build output, dependencies, local environment files, editor
      directories, coverage, caches, and the project's scratch location.
- [ ] Check that ignored patterns are not so broad that they hide real source (a pattern that also matches a source
      directory is a finding).
- [ ] Check the attributes file: line endings, binary markers, and whether generated files are marked so diffs and
      merges behave.
- [ ] Check for generated files tracked in the index: build output, lockfile-like caches, type stubs, coverage reports,
      database dumps, screenshots pasted into the tree. Each is noise in every diff and every clone.
- [ ] Check for large/binary files in the index: media assets that should live outside, archives, database dumps, and
      profiles. Report sizes.
- [ ] Check for secrets in the working tree and in the history. **Search for variable and key names; never print
      values.** For anything found in history, state that rotation — not deletion — is the fix.
- [ ] Check for files that look like personal or machine-specific configuration committed by accident.
- [ ] Check commit-message quality on a sample: does a message explain _why_, not just _what_?
- [ ] Check whether large changes are mixed with unrelated changes in single commits (which makes history useless for
      archaeology).
- [ ] Check the branch situation: long-lived branches, a default branch that is not protected, merge vs rebase
      convention consistency.
- [ ] Check the hooks: is there a pre-commit hook, what does it run, and can it be bypassed? A hook that is slow gets
      bypassed; a hook that is fast and correct gets followed.
- [ ] Check the hook configuration matches what the documentation claims.
- [ ] Check for merge commits from merge branches that were never deleted. `MAY` — report only if the count is
      non-trivial, and say what you counted.
- [ ] Check the tag/release convention, if releases exist.
- [ ] Check whether the history has been rewritten recently in a way that invalidates references in documentation.
- [ ] Check that the repository is not carrying a duplicated subtree or a vendored copy of another repository without a
      stated reason and an update procedure.

### 2.21 CI/CD and developer experience

**Goal.** Establish that the pipeline blocks real regressions quickly, deploys correctly, and that the repository is
pleasant and safe to work in.

**Read.** Every workflow file in full — triggers, jobs, steps, conditions, permissions, caching, timeouts. The
deployment configuration and the deploy command. The contributor documentation. The scripts the documentation tells a
developer to run. The environment files the pipeline consumes.

**Measure.** Wall time of the blocking pipeline. Which jobs are required. Cache hit rates, if observable. Count of steps
that could fail non-deterministically. Time to build, lint, typecheck, and test locally.

**Deliverable.** A pipeline defect list and a DX defect list, each with a concrete reproduction.

**Must not conclude without evidence.** Do not report a pipeline job as ineffective without reading its condition and
its triggers. Do not report a slow build without a timing measurement. Do not report a stale comment without reading
the deployed value it describes.

Checklist — pipeline:

- [ ] List every workflow, its trigger, and its job. A job that runs on a schedule but not on pull requests cannot block
      anything.
- [ ] Check which jobs are actually required to merge. A check that is not required is advisory and will be ignored.
- [ ] Check the pull-request trigger covers the branches you expect, including release branches and forks.
- [ ] **Check the build inputs that are not in the repository.** A value injected at build time from a variable, a
      secret, or a variable file is an input the code review cannot see and the local build cannot reproduce. List them
      all, and check each is fail-closed (an empty value fails the build rather than producing a bundle pointing nowhere).
- [ ] Check caching: what is cached, keyed on what, and whether a stale cache can produce a false green.
- [ ] Check timeouts: a job with no timeout can hang a queue indefinitely.
- [ ] Check concurrency: does a new push cancel the old run, or do they queue and waste capacity?
- [ ] Check least privilege: the token permissions each job requests, and which jobs hold deployment secrets. A job that
      holds secrets while running untrusted build steps is the highest-privilege code path in the system.
- [ ] Check third-party actions are pinned to an immutable reference, not a floating tag. A tag is mutable, and the
      pipeline is the supply chain.
- [ ] Check for secrets exposure: are secrets available to pull-request runs from forks? Is anything printed?
- [ ] Check the failure message quality: when the pipeline fails, does the developer learn what to do?
- [ ] Check the deploy job: what it deploys, from where, with what environment secrets, and whether it is gated on the
      blocking checks.
- [ ] Check the deploy path argument carefully: a deploy command that uploads the wrong directory is a catastrophic and
      entirely avoidable failure. Verify the argument resolves to the build output, not to the project root — some tools
      silently rewrite a relative path against the package root, which turns "upload the build" into "upload the source".
- [ ] **Check the post-deploy smoke test can actually fail.** A gate that probes only the site root passes when the
      application shell loads but the routing, the API call, or a runtime asset is broken. The gate should probe a deep
      link and at least one runtime asset the build produced, and a smoke check that is skippable is not a gate.
- [ ] Check that the deployment ships the files the build produced plus the policy files the runtime needs (headers,
      redirects, and any post-processing step). A policy file that exists in the source tree and is never copied is a
      policy that does not exist in production.
- [ ] Check the migration ordering: migrations run before the deploy, from a separate step, additive and idempotent,
      and safe while the currently-running version is still serving. A migration that is not backward-compatible with
      the running version converts a deploy into an outage, and the window between the two steps is where it happens.
- [ ] Check the version-skew window explicitly: for how long do the old and new versions of the application and the
      schema coexist, and is every change in that window compatible in both directions?
- [ ] Check the platform's own fail-open or fail-closed mode for route errors, which is a dashboard setting rather than
      a file, and decide whether an error should take the route down or serve a stale response.
- [ ] Check that CI runs the same commands the project documents for local development. Divergence means the local gate
      is not a gate.
- [ ] Check that the test suite CI runs is the full suite, not a subset selected for speed, and that the end-to-end
      suite's own service dependencies match production's shape (a database that is not a replica set in CI is a
      transaction path never exercised).
- [ ] **Audit the explanatory comments the pipeline carries.** A comment stating a default, a mode, or a mechanism is a
      claim about the deployed system; reconcile it against the deploy command. A comment that cites a file and a line
      is the most dangerous kind, because it looks authoritative — and a correct mitigation justified by a wrong
      explanation gets "corrected" back by the next maintainer.

Checklist — developer experience:

- [ ] Does the documentation match the code? Verify every documented command actually exists and works. A stale command
      is worse than no command.
- [ ] How hard is it to _find_ a feature: can a newcomer locate where a feature's code, tests, and styles live? Give
      the answer as a count of directories searched, or drop the question.
- [ ] How hard is it to _add_ a feature end to end: how many files must be touched, and is any of it non-obvious?
- [ ] How hard is it to _change_ an existing feature: count the files a typical change spans. This is the DX number that
      predicts the architecture's health.
- [ ] How long do build, lint, typecheck, and test take locally? Report the numbers; a gate over a few minutes gets
      skipped.
- [ ] Migration ergonomics: when a data shape changes, is there a documented, tested, idempotent migration path? Is
      running it a single command?
- [ ] Quality of developer-facing error messages: when a build fails, is the error actionable? Check a real failure.
- [ ] Is there a one-command local environment bootstrap? Does it work from a clean clone?
- [ ] Is the local development loop documented well enough that a new contributor needs no oral history?
- [ ] Is the test-writing burden reasonable? Tests that are painful to write get written badly or not at all.

### 2.22 Finding format

Every finding, without exception, uses this shape:

```text
id:            <track-letter><sequence>          # e.g. A7 — stable, never reused
title:         one line, imperative or declarative
status:        MUST | SHOULD | MAY | CONTEXT-DEPENDENT   # the obligation the violated check carries
severity:      critical | high | medium | low | info
category:      the track it came from
invariant:     the rule this violates, and where it comes from (spec / advisory / platform guarantee / project decision)
location:      file(s) and line(s) — required, no exceptions
evidence:      the command run + its exit code, or the quoted code, or the query result
problem:       what is wrong, in one or two sentences
impact:        what it costs — an incident, a blocked change, an ongoing risk, a maintenance tax
fix direction: where the fix belongs, not the patch itself
confidence:    high | medium | low — and why
effort:        <1h | <1d | multi-day
reachability:  (security-shaped findings) entry point, caller's minimum privilege
exploit:       (security-shaped findings) one sentence: who does what where and gets what
enforcing:     the artefact that would prevent recurrence, or "none" — and its tier
failure delay: build | CI | runtime | never
dependencies:  other finding ids, or none
revalidate:    what a future agent must re-check before trusting this finding, and against which source
```

Rules for writing findings:

- [ ] **Evidence is mandatory.** A finding without evidence is deleted, not downgraded.
- [ ] **Inventing findings is forbidden.** If you did not read it, run it, or query it, it does not exist. A plausible
      defect you have not verified will be "fixed" by someone, wasting their time and damaging trust in the report.
- [ ] **Quote, do not paraphrase.** Include the line that proves the finding.
- [ ] One finding, one problem. Do not bundle three observations into one id; they will be triaged together and two will
      be lost.
- [ ] **Name the invariant.** A finding with no stated invariant is a preference, and preferences do not survive review.
- [ ] Severity reflects impact × reachability, not how bad the code looks. Status is the obligation, not the severity;
      keep the two apart.
- [ ] "Fix direction" names the seam, not the code. If you can write the patch, you have crossed into Phase 4.
- [ ] "Enforcing" is mandatory even when the answer is "none": a defect class with no enforcing artefact is the
      work item that produces the preventive fix, and writing "none" is how it gets noticed.
- [ ] "Revalidate" is mandatory for anything derived from a library's behaviour, a platform's guarantee, or a
      specification. Write what must be re-read and where — the finding is then safe to keep after the knowledge ages.
- [ ] Confidence is honest. "Medium — inferred from the call graph, not executed" is a valuable finding. A finding
      presented as high confidence when it is a guess is a liability.
- [ ] Prefer fewer, proven findings over many, suspected ones. A report of forty verified defects is more useful than
      two hundred with a third unverified.

### 2.23 The refuted log

Maintain a mandatory second list: **claims that were checked and did not hold up**. This list is as important as the
findings list.

- [ ] Record every hypothesis you formed, tested, and could not confirm — including your own earlier findings that later
      evidence contradicted.
- [ ] For each: what was claimed, how it was tested, what the evidence showed, and the conclusion.
- [ ] Include checks that came back clean and were surprising: "suspected N+1 in the list endpoint; traced 6 queries,
      all batched; refuted."
- [ ] Include anything a previous report claimed that you could not reproduce.
- [ ] Note the checks you could not perform at all as **not verified**, distinctly from refuted.
- [ ] **Every negative security result gets an entry**, and every entry states the mechanism that makes the class
      inapplicable and the condition that would change it. "No shell in the codebase, therefore no command injection" is
      a negative with a trigger; a bare "no command injection found" is not.
- [ ] **Every knowledge claim that turned out to be wrong gets an entry too** — a mechanism that does not do what its
      name suggests, a folklore explanation refuted by the installed source, a version whose behaviour differs from
      the previous one under identical code. These entries are what stops the next agent from repeating the mistake, and
      they are the reason this playbook's deep checks carry a `Freshness` line rather than a version.
- [ ] Never delete a refuted claim because it looks silly. A documented wrong turn saves the next agent the same hour
      and stops someone "fixing" a non-existent problem from an older note.
- [ ] The refuted log is what makes the findings list trustworthy: it demonstrates the checks were actually run.

### 2.24 The cross-stack seam pass

**Why this pass exists.** A track-by-track audit asks what each technology requires. Each half of a system is then
audited against its own rules, correctly, and the boundaries between halves are audited by nobody. That is where the
uncaught defects live: not in a component that violates its own framework's guidance, but in a pair of components that
are each correct and jointly wrong. The failure signature is consistent: in a real seam audit of one production
repository, the large majority of the live defects found at a seam sat in places every existing check passed, because
each existing check's unit (a route, an index, a mechanism, a function) is not the unit of the defect. Treat the
proportion as a reason to run the pass, not as a figure to quote — measure it in your own run and record it there.

#### The corrections that survive

These are the most useful corrections this method has produced. Each is a change of **audit unit**, and each one was
adopted because a real defect passed every check written against the older unit.

> **Audit the query, not the route.** An id-bearing route cannot address a count without the scope predicate, an
> aggregation whose first stage omits it, an audit trail keyed on the entity alone, or a counter whose key omits the
> tenant. All four are the same defect, and none is reachable by enumerating routes. Enumerate every query
> construction and name the clause that carries the scope. (DC-2.6-03, DC-2.8-02.)

> **Audit the actor, not the index.** A data lifecycle can be modelled, documented, tested, given a purge function and
> an expiry index, and still never execute — because no actor runs it. A check phrased about a mechanism that exists
> passes while the lifecycle does nothing. For every dataset that must be reclaimed, name **who removes it and when it
> last ran**. (2.6, "Name the actor that executes a data lifecycle".)

> **Audit what the test runner does not execute.** A suite that mocks every collaborator correctly can still execute
> none of the platform the design rests on: no isolate lifecycle, no I/O-context rule, no CPU ceiling, no eviction, and
> a database whose shape differs from production. The harness is the object of the audit. (2.14, DC-2.14-01.)

> **Audit the comparison and the clock, not the value and the timestamp.** A store, a client and a specification each
> define their own equality, their own ordering, and their own "now". Two halves that are each correct then sort,
> deduplicate, expire and enforce uniqueness under different rules, and the defect surfaces as a duplicate row, a page
> that repeats itself, a uniqueness constraint that does not hold, or a credential that expires early — with no error
> anywhere. (DC-2.6-05, DC-2.8-07.)

#### The seams to walk

The list below is the recurring set for a web application with a document database and a client. Adapt it to the
architecture in scope — the point is the method, not the list:

1. Browser application ↔ HTTP API
2. Client-side validation ↔ server-side authority
3. A shared contract package ↔ the two build targets that consume it
4. Credential storage ↔ the cross-origin API it authenticates to
5. Edge runtime ↔ connection lifecycle ↔ document database
6. Object identity ↔ per-request in-memory state (rate limits, counters, caches)
7. Outbound third-party call ↔ the request budget and the deferred-work window
8. Stored rich text ↔ every consumer that renders it
9. Tenant scoping ↔ derived reads (counts, aggregates, search, audit, exports)
10. Background or scheduled work ↔ a data lifecycle
11. Runtime-fetched assets ↔ the cache policy at the edge
12. The store's comparison and ordering rules ↔ the client's
13. Every clock the system reads ↔ every clock it is compared against

#### The method, per seam

- [ ] **Name the two actors** on each side, and the boundary where they hand data to each other.
- [ ] **Write down each side's assumption about the other** — what it expects the other to have checked, to have
      bounded, to have made durable, to have made idempotent. Most seam defects are a missing assumption, not a missing
      check.
- [ ] **Ask what happens when the assumption is false.** A timeout that returns a result, a result that arrives without
      the state it assumed, a scope that is not what the caller believed, an actor that never runs.
- [ ] **Classify the seam** with one of four verdicts: the pattern is present and handled; present and **unhandled**
      (a live finding); absent; absent **by architecture** (the class cannot occur, and the architecture is documented).
- [ ] **Record which existing check the defect passes.** This is the column that makes the pass worth running: a
      defect that several checks pass is a defect the checklist cannot reach, and it is the evidence for the material
      change rather than a new item.
- [ ] **For an absent seam, write the trigger.** What capability, if added, would make this seam live? The trigger turns
      a coincidence of architecture into a recorded decision (0.5, 2.0.4).

#### The deliverable

A table with: seam · the two actors · the assumption each makes · verdict · the live defect if any · **which existing
check passes it** · the trigger for the absent ones. Then, in the report, the three sentences that generalise: which
seams carried a live defect, what class they share, and which unit of audit the playbook should change because of them.

---

## 3. Phase 2 — Prioritisation

Input: the finding list plus the refuted log. Output: an ordered, deduplicated, owner-reviewable set of defects and work
packages.

### 3.1 Deduplicate

- [ ] Collapse findings that share a root cause into one defect, and list every finding id that folded into it. The
      count of raw findings is not the count of problems.
- [ ] Build a **map of which tracks saw which defect.** A defect found independently by four tracks is a defect whose
      cause is structural — the boundary is wrong, not one implementation. A defect found by the seam pass and by no
      track is the same signal in a different place, and it is the one to look at hardest.
- [ ] Merge duplicates that differ only in location (the same missing validation on six routes is one defect with six
      locations).
- [ ] Keep separate anything that needs separate verification. Merging two defects that a single test cannot cover
      produces an unverifiable work package.
- [ ] Preserve the evidence of every merged finding. Deduplication loses supporting evidence if done carelessly.
- [ ] Do not merge across seams. Two findings at two different seams may share a root cause and still need two
      guardrails, because each guardrail is enforced at its own seam.

### 3.2 Score each defect

For every deduplicated defect, record all of the following. All are mandatory.

- [ ] **Severity** — impact if it fires, × how reachable it is. Use critical / high / medium / low, and justify the
      rating in one sentence. A severity without a sentence is an opinion.
- [ ] **Impact** — stated concretely: data loss, an outage, a security breach, a blocked feature, a daily maintenance
      tax, a false sense of safety from a broken guardrail.
- [ ] **Confidence** — high / medium / low, **and why**. Confidence is about evidence, not about how sure you feel.
      "High: reproduced with a failing test" is a different claim from "Medium: read the code path, not executed".
- [ ] **Effort** — <1h, <1d, multi-day. Include the _guardrail_ effort, not just the fix effort; a two-hour fix with a
      two-day test is a three-day package, and mis-sizing it is how a plan loses its owner.
- [ ] **Regression risk of the fix** — how likely the fix itself breaks something. Factor in the _existing test coverage
      of that area_: **an area with no tests has a high regression risk by definition**, because there is no net under
      the change. State this explicitly for every defect in an untested area, and prefer to write the test first.
- [ ] **Enforcing artefact** — what currently prevents recurrence, and its failure latency (2.0.3). "None" is a
      common and expensive answer, and it is the reason the defect exists.
- [ ] **Knowledge dependency** — does this finding rest on a library's behaviour, a platform's guarantee, or a
      specification? If so, record what must be revalidated before the finding is acted on, and treat the finding as
      inherited rather than verified until someone re-reads it (0.3).

Do not confuse the finding's **obligation status** (0.5: MUST / SHOULD / MAY / CONTEXT-DEPENDENT) with its **bucket** in
3.3. Status is a property of the violated check and travels with the check; the bucket is a property of this run's
priorities and is the owner's to change.

### 3.3 Assign a bucket — and write the rule down

Buckets: **Must** / **Should** / **Nice**.

- [ ] Write the assignment rule down _before_ assigning, and apply it mechanically. A rule written afterwards
      rationalises whatever you already decided.
- [ ] A workable default rule: - **Must** — a live security defect; data loss or corruption; an outage; a broken
      build/gate; a defect that will actively mislead the next maintainer (a lying guardrail, a lying metric, a lying
      document); anything blocking a release. - **Should** — a correctness defect with bounded reach; a structural cause
      that will generate more defects; a gap in a critical path's test coverage; a measurable performance problem with a
      known cause. - **Nice** — quality, consistency, DX, and long-tail performance. Real, but not urgent.
- [ ] Record the rule in the report, next to the assignments. The owner can disagree with the rule; they cannot argue
      with an assignment made under an unstated rule.
- [ ] Never assign by "what I found interesting". Interest is not a priority.
- [ ] A `MAY` check that produced a finding is usually a **Should** at most — and if the project has already decided, it
      is a note. A `MUST` check that produced nothing is a result; a `MUST` check that could not be run is a gap with an
      owner, and it is reported as one.

### 3.4 Classify the fix type

For each defect, record which of these the fix is. A defect can require more than one; the classification drives the
wave assignment in Phase 3.

- [ ] **Hotfix** — a localised change that corrects behaviour without changing structure. Cheapest; lowest risk.
- [ ] **Structural** — a change to a boundary, seam, or data flow. Expensive, high impact, needs its own wave.
- [ ] **Preventive (guardrail)** — a mechanism that makes the defect class impossible or fails the build on recurrence.
      A defect whose root cause was a missing guardrail gets a preventive fix _in addition to_ its hotfix, not instead
      of it.
- [ ] **Deletion** — remove the code. Always a candidate, and chosen when the feature is provably unused, when the code
      is unreachable, or when the feature is superseded. Requires proof of non-use (see traps: dead code a test was
      still exercising).

### 3.5 Root-cause analysis

- [ ] For each Must and Should defect, ask: what single seam, if fixed, prevents this whole class? Prefer one seam over
      twelve patches. Twelve patches to twelve sites is a system that will need a thirteenth.
- [ ] **Ask the same question of the audit's own unit.** If a defect passed several existing checks, the cause is that
      the checks are phrased about the wrong thing — a route rather than a query, a mechanism rather than an actor, a
      function rather than a runtime. Record the unit change; it is a playbook improvement, and it is the highest-value
      output a track can produce about itself.
- [ ] Distinguish **"a fix"** from **"the guardrail that should have caught this."** A defect that shipped because
      nothing tested for it needs both. Record the two separately so neither is lost.
- [ ] Group defects by root cause, not by location. If six routes lack validation, the cause is one missing mount point,
      not six missing schemas.
- [ ] Identify the **highest-leverage single change** in the whole set. It is usually a default, a base class, a
      middleware mount, a shared schema, a required parameter, or a lint rule. Prioritise it accordingly.
- [ ] Name the defects that are _symptoms of an architectural decision_. Those do not get patches; they get an entry in
      the deferred list, or a structural work package.
- [ ] For each root cause, state what the guardrail should be and where it belongs. If the answer is "there is no good
      place to put it", that itself is a structural finding.
- [ ] For each root cause, state which seam it lives on (2.24). A root cause that is not attributable to a seam is
      usually a local defect, which is the easy case.

### 3.6 Resolve contradictions between tracks

- [ ] List every contradiction explicitly: two tracks that disagree about the same code, or a finding that a later track
      invalidated.
- [ ] Resolve each by re-reading the code and re-running the measurement, not by preferring one track's confidence
      level. A track that read more code usually wins; a track that ran the measurement usually wins over one that read.
- [ ] **Prefer the deployed value over the documented one** when a comment and a configuration disagree: the
      configuration that runs is evidence, the comment is a claim.
- [ ] Record the contradiction and its resolution in the report. A silently dropped contradiction is how a defect
      survives the audit.
- [ ] Where a contradiction reflects a genuine disagreement about _intent_ (not about facts), convert it into an open
      question for the owner. Do not pick a side.
- [ ] Where the contradiction is between two *sources* rather than two tracks — the documentation says one thing and
      the installed source another — record both, state that the source wins, and say what the documentation now needs.

### 3.7 Compile the owner questions

- [ ] Collect every decision that only the owner can make. Each is a **question**, not a suggestion.
- [ ] Phrase each as: **question** + **what it blocks** + **options**, with the options being genuinely different
      behaviours, not degrees of the same thing.
- [ ] Include the questions the audit could not answer for want of an input: a number nobody has measured, a platform
      setting nobody has looked at, a retention decision nobody has made. These are the most valuable questions in the
      report, because they are the ones a future run cannot answer either.
- [ ] Rank the questions by how much work they unblock, so the owner can answer the cheapest high-leverage one first.
- [ ] Mark every defect and work package that depends on an open question. Those stay untouched until it is answered
      (see Phase 4).
- [ ] Do not ask a question you can answer by reading the code. The question list is short by design; a long one means
      the audit under-invested in evidence.

---

## 4. Phase 3 — Refactor plan

Input: the prioritised defect list, the guardrail requirements, and the open questions. Output: waves and work packages
that can be executed by an agent that has never read the codebase.

### 4.1 Waves

Order the work as follows. The ordering rationale is that cheap corrections first buy credibility, and expensive
restructure last means the structure is built on corrected foundations.

- [ ] **Wave 0 — quick wins.** Anything under an hour with no prerequisite and no structural risk. Ship immediately.
- [ ] **Wave 1 — correctness.** Defects that produce wrong results, wrong data, or silent failures. Tests first where
      none exist.
- [ ] **Wave 2 — security and foundation.** Guardrails, validation coverage, access control, and the configuration and
      pipeline defects that make everything after them safer to do.
- [ ] **Wave 3 — structure.** Layering, duplication, type/domain model, and the high-leverage seam identified in the
      root-cause analysis. The expensive wave; it comes after the cheap ones have proven the gate works.
- [ ] **Wave 4 — performance and size.** Only after correctness, because optimising wrong code wastes the effort.
- [ ] **Wave 5 — quality, consistency, and DX.** Polish, accessibility polish, documentation accuracy.

### 4.2 Dependency graph

- [ ] Draw the dependencies between work packages explicitly. A package with no incoming dependency can start
      immediately.
- [ ] Identify packages that must not run concurrently because they touch the same files (one owner per file).
- [ ] Identify packages that must run in a strict order and say why in one line each.
- [ ] Identify packages that are safe to run in parallel with which others — this is what makes the plan executable by
      several agents at once.
- [ ] Mark the critical path through the graph. Everything not on it is optional for the first pass.

### 4.3 Work package template

Every work package gets this, filled in completely. A package with a blank field is not ready to dispatch.

```text
id:              WP-<n>
title:           one line
closes:          the defect ids this package resolves (all of them)
seam:            which seam it lands on, or "none — local"
prerequisites:   the package ids that must land first
files:           the exact files this package may edit — the ownership boundary
size:            <1h | <1d | multi-day   (including the guardrail)
risk:            low | medium | high — and the specific reason
existing gate:   which existing command covers this work
new test:        the test to write BEFORE the fix, and what it asserts
guardrail:       which form it takes (type / table / behavioural / lint / source scan) and where it lives
proves by:       how the guardrail will be shown to fail before the fix
revalidate:      what must be re-read before this package is executed, if the fix rests on library or platform behaviour
ships alone:     yes | no — and if no, what it must ship with
needs a flag:    yes | no — and the flag name and removal plan
needs migration: yes | no — and the exact migration, additive and idempotent
rollback:        how to undo this specific change
behaviour change: the externally visible differences, listed explicitly
verification:    the exact commands to run, and the expected result
```

### 4.4 Rules for the plan

- [ ] **Every package has a verification step naming an existing command**, plus **the new test that must exist before
      the fix**. "Run the tests" is not a verification step; the named command and the expected exit code is.
- [ ] If no existing command covers the change, that is itself a gap: either the package adds the command to the gate,
      or it explains why the existing gate is sufficient.
- [ ] **A package that cannot be verified independently does not ship alone.** Say so explicitly and pair it.
- [ ] **The guardrail protects a property, not a coupling.** Before dispatching, read the proposed assertion and ask
      what a *correct alternative implementation* would look like, and whether it would pass. If it would fail, the
      guardrail is asserting the current shape, and it will block the next good fix. See 5.1.
- [ ] **The guardrail sits on the side of the seam where the defect would occur.** A test on the write path cannot
      protect a read-side property, and a test on the server cannot protect a client-side defect. State the side in the
      package.
- [ ] **Flag anything that needs a feature flag** so it can be enabled in production and disabled without a deploy. A
      structural change behind a flag is the difference between a rollback and an incident.
- [ ] **Flag anything that needs a migration** and state the migration's properties: additive, idempotent, safe while
      the previous version is still serving traffic, and runnable before the new code is live.
- [ ] **Every package has a rollback story.** "Revert the commit" is a rollback story only if the change is
      self-contained. If the change is not self-contained, the rollback must say what data or state needs undoing.
- [ ] Prefer many small packages over few large ones. A package a single agent can hold in its head is a package that
      gets finished.
- [ ] A package that touches more than roughly a dozen files is probably two packages. Say how to split it.

### 4.5 Definition of done per wave

Every wave needs a measurable definition of done. Write it before the wave starts:

- [ ] **Gate:** the canonical gate command passes, with the exit code recorded.
- [ ] **Guardrails:** every package in the wave has its guardrail landed, and each guardrail has been proven to fail
      when the defect is reintroduced.
- [ ] **Deletions:** the code that became unreachable has been removed, not left commented out.
- [ ] **Documentation:** any rule the wave added or changed is written down where the next agent will read it — and
      every explanatory comment the wave touched has been re-verified against the source it describes.
- [ ] **Deltas:** the before/after numbers for anything the wave claimed to improve (test count, bundle size, timing),
      measured the same way as before.
- [ ] **No new findings:** nothing the wave introduced is left undiscovered. Run the relevant tracks again over the
      changed area, and re-run the seam pass over any seam the wave touched.
- [ ] **Clean state:** no leftover generated files, no scratch committed, no debug logging, no temporary branch.

### 4.6 Quick wins

- [ ] List every defect fixable in under an hour with no prerequisite, no structural risk, and no open question.
- [ ] For each, name the exact file, the exact change in one sentence, and the command that verifies it.
- [ ] Quick wins still need a guardrail if they are a defect class rather than a one-off. A one-off needs a test; a
      class needs a mechanism.
- [ ] Ship them first and separately. They buy the owner confidence in the larger waves.

### 4.7 Do-not-do list

Tempting refactors that add risk without value. Write this list explicitly — an unstated do-not-do list is a plan
someone will argue with in week two.

Typical entries, each with a reason:

- [ ] "While we are in there" refactors that are not in the plan. The plan is the contract; extra changes are how a wave
      loses its verification story.
- [ ] Rewriting a module that works, because it is ugly. Ugly and correct beats pretty and broken; schedule it as
      quality work with its own test coverage, not as part of a defect fix.
- [ ] Introducing an abstraction for a second implementation that does not exist yet. One implementation is a
      hypothesis.
- [ ] Enabling a strictness flag as part of a defect fix. It is its own work package with its own measured cost, and
      mixing it into a fix destroys the fix's verification story.
- [ ] Rewriting vendored library code in place. That is a fork; see the guards in 2.3.
- [ ] Changing the lint configuration to make a finding disappear instead of changing the code.
- [ ] Deleting code whose only remaining reference is a test, without reading the test.
- [ ] Upgrading a dependency in the same commit as a fix. Two changes, one verification story, no isolation.
- [ ] Reformatting a file you are fixing. It destroys the diff and hides the change.
- [ ] Restructuring directories. It touches every file, breaks every reference in every document, and delivers no
      behaviour change.
- [ ] Fixing a mechanism's comment without fixing the mechanism, or the reverse. Both are separate changes with
      separate verification.

### 4.8 Deferred pending owner answers

- [ ] List every defect and package blocked on an open question.
- [ ] For each, state the question, what happens if the answer is the other option, and what the cost of the delay is.
- [ ] Mark these clearly as **not started**. A deferred item that looks started is the most dangerous kind.
- [ ] Anything gated on an open question stays untouched in Phase 4. Not "fixed conservatively" — untouched.

---

## 5. Phase 4 — Fixes

### 5.1 The guardrail forms

**Every fix needs a guardrail.** A fix without one is a patch with an expiry date: the same defect recurs, and this time
nobody is looking. The form must match the defect class, and the form determines when the recurrence is noticed.

| Form                | What it looks like                                                                                                                                                 | Noticed at |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Type-level**      | The unsafe call is unrepresentable: a required parameter, a closed type, a branded identifier, a validated configuration object.                                  | Build      |
| **Table-level**     | A test enumerates a structure — the route table, the declaration set, the page list, the schema list — and asserts every row is covered.                     | CI         |
| **Behavioural**     | A test asserts the behaviour, written before the fix, and observed to fail before it.                                                                              | CI         |
| **Lint / static**   | A rule for a class of style or correctness issues the tool can see, matching the repository's existing rule style.                                                   | CI         |
| **Source scan**     | A test over the _shape_ of the codebase: every route factory mounts the validation middleware, every page declares a title, every `:param` has a schema, no hand-rolled error body exists. | CI         |
| **Contract**        | Two things that must agree are made one thing, with the second derived from the first.                                                                            | Build      |

- [ ] **Choose by how the defect could recur.** If it could recur through a _new_ call site, a _new_ route, or a _new_
      declaration, use a mechanism or a table-level test — anything that requires remembering. If it could only recur by
      changing existing logic, a behavioural test is enough. If it is about the shape of the codebase, scan for it.
- [ ] **Make two-way guardrails.** The strongest table-level form asserts both directions: every declaration is used
      _and_ every used name is declared. A one-way test passes while the drift it exists to prevent accumulates in the
      direction nobody checked — and that direction is where the next defect lives.
- [ ] **Put the guardrail on the side of the seam where the defect occurs.** A test that checks a write path cannot
      protect a read-side property; a server-side test cannot protect a client-only defect. Ask which side the next
      instance of this class would appear on, and put the guardrail there.
- [ ] **Assert the property, never the shape.** Write down a correct alternative implementation and check whether your
      assertion would still pass. "This route validates its parameters" survives; "this route calls this function in
      this order" does not. A guardrail that blocks the correct fix is itself the defect, and it is trusted, which makes
      it worse than no guardrail.
- [ ] **Test the absent-input path.** A guard that no-ops when its input is missing passes every ordinary test, because
      the caller usually prevents the case. The guardrail for such a guard is a test that omits each input and asserts
      the refusal — a test that exists to be impossible to satisfy accidentally.
- [ ] **Check the existing shape first.** If the repository already has this kind of guardrail, follow its form. A
      novel mechanism in a codebase with a convention is a mechanism the next maintainer does not look for.
- [ ] **A guardrail that removes the possibility beats one that checks it.** If the defect could be designed out —
      a required parameter, a single derived contract, a default-by-construction path — do that instead of writing a
      test that watches for the mistake.

### 5.2 Proving a guardrail fails

- [ ] **Temporarily reintroduce the defect** and observe the guardrail fail. This is the only proof that the guardrail
      is real.
- [ ] Record the evidence: the command, the exit code, and the failure message. A guardrail that has never been seen to
      fail is a hypothesis.
- [ ] Revert the reintroduced defect and confirm the guardrail passes again.
- [ ] **Prove it fails for the right reason.** Read the failure message. A guardrail that fails on an unrelated
      assertion, or that fails because of a different defect the reintroduction also caused, is not protecting what you
      think it protects.
- [ ] **Prove it is not a coupling.** Change the code to a different, equally correct implementation, and confirm the
      guardrail still passes. If it fails, it is asserting the current shape, and it will block the next good fix.
- [ ] **Prove it does not fire on correct code.** A guardrail that rejects an equally correct implementation is not
      strict, it is broken: it gets routed around, and once bypassed it protects nothing while still being trusted.
      That is the same test as the item above, read in the other direction — the alternative implementation is the
      control, and when it fails, fix the assertion rather than the code.
- [ ] **Check the guardrail fails on the side it claims.** A test that passes for the wrong reason — because the thing it
      asserts is true for an unrelated reason, or because the enumeration it walks is empty — is the most dangerous
      artefact in the repository: it is trusted, it is green, and it protects nothing. Confirm the enumeration is
      non-empty and that the assertion is discriminating.
- [ ] If the guardrail cannot be made to fail — because it asserts nothing, or asserts something already true for the
      wrong reason — the guardrail is wrong. Fix it before moving on. A guardrail that cannot fail is worse than no
      guardrail, because it is trusted.
- [ ] **Check the guardrail's other side.** A source scan that proves every declaration is used, without also proving
      every used name is declared, has protected one direction only; the defect class recurs in the other direction and
      the guardrail is green throughout.
- [ ] Include this proof in the report. It is the difference between "I added a test" and "the defect cannot recur".

### 5.3 Order of work

Within a wave, in this order:

1. **Infrastructure** — the shared mechanism, base class, middleware mount, or schema the fixes depend on. Do this
   first; everything else builds on it.
2. **Guardrail** — land the failing test or the mechanism, and _see it fail_. Before the fix, not after.
3. **Refactor** — the behaviour change itself.
4. **Documentation** — the rule, the seam, the reason. Written last, when the final shape is known, so it describes what
   the code actually is.

### 5.4 Behaviour changes

- [ ] Every fix enumerates its **externally visible behaviour changes** for the owner to review. Even when there are
      none, say so explicitly — "no externally visible change" is information, and silence is not.
- [ ] Externally visible means: an API request or response changes shape, status, or timing; a stored document changes;
      a permission changes; a user-visible string or a validation rule changes; a configuration variable is added,
      renamed, or given a new default; a dependency's version range changes; a scheduled job's timing changes.
- [ ] List them as: **before** → **after** → **who is affected** → **reversible?**
- [ ] Anything a deployed client might depend on is externally visible, even if the server considers it internal.
- [ ] Route every behaviour change through the open-question filter: if the change is a product decision rather than a
      defect fix, it is gated and stays untouched.

### 5.5 Subtask brief skeleton

Dispatch a subtask with this structure, filled in completely. An incomplete brief produces a subtask that guesses.

```text
# Subtask: <title>

## Context
What this subtask is part of, what problem it solves, and the defect ids it closes.
2-5 sentences. Assume the reader has never seen this repository.

## Boundary — files you own
The exact files you may edit. Anything outside this list is another subtask's.
If you need a change outside it: stop, record the request, hand it back. Do not edit it.

## Read first
The specific files and sections to read before writing anything, in reading order.
Include the declared rules that apply to this work, quoted.
If the fix rests on a dependency's or a platform's behaviour, name the source
that must be re-read first, and say what to check it for.

## Required changes
Each change as: what, where, and why. Specific enough to implement without
rediscovering the analysis.

## Guardrail requirement
Which form (type / table / behavioural / lint / source scan), which side of the
seam it sits on, and what it asserts. It must fail before the fix and pass after.
State how you will demonstrate the failure, and how you will show it is not a
coupling to the current implementation shape.

## Verification and baseline
The baseline result (before your change) and the exact commands to run after,
with the expected exit codes. If the gate was already failing, say so and do not
claim to have fixed it.

## Prohibitions
- Do not edit files outside your boundary.
- Do not change configuration, manifests, or lockfiles.
- Do not reformat, rename, or move files.
- Do not fix defects outside your brief; record and hand back.
- Do not commit or push.
- Do not weaken or delete an existing assertion.
- Do not install dependencies.
- Do not work on anything gated on an open owner question.
- Do not "fix" a comment's explanation without verifying it against the source
  it describes; if the explanation is wrong and the mechanism is right, say so
  and let the owner decide.

## Report format
What to return: the files changed, the guardrail and its failing-then-passing
evidence, the commands run with exit codes, the behaviour changes, anything you
could not verify, and anything you found outside your boundary.

## Completion criteria
- [ ] Every required change made.
- [ ] Guardrail lands and its failure was observed, for the right reason.
- [ ] Baseline and post-change gate results recorded with exit codes.
- [ ] Behaviour changes listed (or explicitly "none").
- [ ] Out-of-boundary findings handed back, not fixed.
- [ ] No file outside the boundary touched.
```

### 5.6 Dispatch rules

- [ ] **One owner per file.** Assign ownership in every brief; enforce it. Two owners means a silent merge.
- [ ] **Parallelise only along the dependency graph.** Packages with no dependency on each other and disjoint file sets
      may run concurrently. Anything else runs in sequence.
- [ ] **Cross-track findings go back to the orchestrator as tasks**, never fixed in passing. Record them with the same
      finding format.
- [ ] **Control the run after each wave.** The orchestrator re-runs the gate, reviews the diff, and dispatches the next
      wave. Never dispatch wave N+1 while wave N is unverified.
- [ ] **Verify the baseline before each wave**, not once at the start. A wave that inherits someone else's red gate
      produces a meaningless result.
- [ ] **Keep a per-wave diff summary**: files changed, lines, and the behaviour changes. The owner reviews this, not the
      full diff.
- [ ] **Stop the whole run** if the gate becomes red in a way the wave did not intend. Do not continue stacking waves on
      an unverified state.

### 5.7 When to stop and ask

Stop and escalate rather than guess when:

- [ ] The fix requires a **product decision** (what the user should see, what a domain rule should be).
- [ ] The fix would **change an externally visible contract** and the intended new behaviour is not documented.
- [ ] The fix requires a **schema or data migration** and the migration's safety properties cannot be established.
- [ ] The fix would require **changing a declared project rule**. Ask before violating it; do not violate it quietly and
      mention it in the report.
- [ ] The fix requires **installing dependencies or touching a lockfile** outside the plan.
- [ ] The **baseline is red** for reasons unrelated to the current work, and you cannot establish whether the change
      helped or hurt.
- [ ] The area has **no tests at all** and the change is not trivially reversible. Write the test first, or escalate.
- [ ] Two subtasks have both touched the same file. Stop both; a conflict resolved by guess is a silent behaviour
      change.
- [ ] The evidence contradicts the plan. Report the contradiction; do not proceed with the plan as written.
- [ ] The fix rests on a **library's or a platform's behaviour you have not re-verified** against its current
      documentation or source. An unverified mechanism assumption is a guess with a diff attached.
- [ ] The **guardrail you can construct protects a coupling rather than the property** — a correct implementation would
      fail it. Stop and redesign the guardrail; a guardrail that blocks the right fix is a defect the team will route
      around.
- [ ] Anything in the deferred list turns out to be a prerequisite. The plan is wrong; say so rather than improvising.

---

## 6. Phase 5 — Verification and report

### 6.1 Clean-state verification

- [ ] **Delete generated artefacts first:** build output, caches, coverage reports, and anything the run generated.
      Verifying against stale output proves nothing about the current source.
- [ ] Re-run the canonical gate from a clean state. Record the exact command and the exit code.
- [ ] Re-run every command named in the plan's verification steps, individually, recording exit codes.
- [ ] If the project has separate blocking and advisory checks, report both, and say which are blocking.
- [ ] Re-run the guardrail proofs: for each guardrail landed this run, reintroduce the defect in a scratch copy or a
      temporary edit, observe the failure, and revert. Record the evidence. A guardrail verified once in Phase 4 but not
      re-verified after later waves is a guardrail that may have been broken by a later wave.
- [ ] **Re-run the seam pass** over every seam a wave touched (2.24). A structural fix moves data across a boundary,
      and the boundary is where the new defect will be.
- [ ] **Re-check the knowledge.** For every finding or fix that rested on a library's behaviour, a platform's guarantee
      or a specification, confirm the source still says what the run assumed, and record any that moved. A run that
      verified code against stale knowledge has verified nothing.
- [ ] Re-run the relevant audit tracks over every changed area. A fix introduces new surface; not looking is how a
      refactor ships a new defect.

### 6.2 Results table

Produce this table. It is the primary evidence artefact of the run.

| #   | Command | Exit code | Headline result |
| --- | ------- | --------- | --------------- |
| 1   | ...     | 0         | ...             |

- [ ] One row per verification command, in the order run.
- [ ] The exit code is not optional and not paraphrased as "passed".
- [ ] The headline result states what the command actually covered.
- [ ] Any command that was not run is a row with exit code `NOT_RUN` and a reason. An absent row reads as a passed row.
- [ ] Add a second table for the **knowledge** the run inherited: what was re-read, against which source, and whether
      the assumption held. Rows for areas that were not revalidated carry the status **inherited**, not verified.

### 6.3 Before/after deltas

- [ ] For every quantity the run claimed to change, report before and after, **measured the same way both times**.
- [ ] Test counts: total and per area; tests added; tests deleted; net. Where the count comes from a command, give the
      command.
- [ ] Coverage: before/after, with the method stated. Do not quote a percentage whose method you did not run.
- [ ] Bundle size: before/after initial and lazy, from a verified measurement.
- [ ] Timings: build, lint, typecheck, test — before/after if they were measured before. If they were not, say they were
      not.
- [ ] Any performance number: before/after with the method and the error bar. A delta smaller than the error bar is not
      an improvement; say so.
- [ ] Files/lines changed per wave, and the net structural change (files added, removed, split, merged).
- [ ] Where a number in the report could not be produced by a command, say how a future run should obtain it. A number
      with no method is a number that will be copied forward and trusted.

### 6.4 Mess check

- [ ] Leftover containers or processes started by the run: list them and stop them.
- [ ] Leftover temporary files, logs, dumps, and profiles outside the designated scratch location.
- [ ] Leftover scratch files — delete them; they are disposable.
- [ ] Modified generated files that should not be tracked.
- [ ] Uncommitted changes in files the run did not intend to touch. Any unexpected diff is a stop-and-investigate item,
      not a cleanup item.
- [ ] **Secrets in the diff:** search the diff for secret variable _names_ and key prefixes. **Never print a value.** If
      a secret was committed, report the file and the name and say that rotation is required — deletion is not.
- [ ] Debug logging, temporary console output, commented-out blocks, and `TODO`s introduced by the run.
- [ ] Lockfile changes, dependency manifest changes, and configuration changes not in the plan.
- [ ] Branches, stashes, or worktrees created by the run.
- [ ] **Durable documentation that points at a scratch file, or that quotes a version number as a rule.** Both outlive
      the run and both become lies.

### 6.5 The owner-facing report

Keep it short and structured. The owner is deciding, not reading.

- [ ] **What was wrong** — the deduplicated defect list, prioritised, each in two lines: what and why it matters. Link
      to evidence, not to a file dump.
- [ ] **What was fixed** — per wave: the defects closed, the guardrail added, the verification command and exit code.
- [ ] **What remains** — the deferred and Nice items, each with its bucket and a one-line reason it was not done.
- [ ] **Externally visible behaviour changes** — the consolidated list from section 5.4, in one place, for the owner to
      review in one sitting.
- [ ] **Deferred items with reasons** — including everything blocked on an owner question, and the answer each is
      waiting for.
- [ ] **New problems discovered while fixing** — the most valuable section in the report, because it is the part no
      amount of planning predicted. List each with its finding id and the decision it needs.
- [ ] **The seam pass result** — which seams carried a live defect, what class they share, and which unit of audit the
      run concludes the playbook should change. This is the section that improves the next run.
- [ ] **What was revalidated, and what was inherited** — the knowledge table from 6.2. It is short, and without it the
      rest of the report reads as verified when part of it was recalled.
- [ ] **Prioritised next steps** — the recommended order, with the reasoning in one line each.
- [ ] **What could not be verified, and why** — the honesty section. Every unverified claim, every command that did not
      run, every check that needed access or environment you did not have. This section is what makes the rest of the
      report credible; an agent that reports a clean run when it verified a third of the surface has done something
      worse than failing.

---

## 7. Typical traps

Each of these is a way a run goes wrong that the process above does not obviously prevent.

- [ ] **A hardcoded version "needed for reproducibility" that silently rots.** It works today, nobody remembers why, and
      in six months it is the only thing blocking an upgrade. Write down _why_ it is pinned, and add a comment that
      names the condition to revisit it. A pin with no recorded reason outlives the problem it solved. The same applies to
      a version number written into a check: the check belongs, the number does not.
- [ ] **Correct code, stale knowledge.** The report is confident, the citations are real, and the material was true of a
      version the project left behind. Nothing in the output looks wrong, which is why it survives review. The re-research
      step is the only defence, and the fix for a report that skipped it is to mark the claim as inherited.
- [ ] **A mechanism that exists, mistaken for a mechanism that runs.** An index, a purge function, a scheduled trigger, a
      retry, a rate-limit counter: all can be present, tested, and documented while the lifecycle never executes. Ask who
      runs it and when it last ran. The audit unit is the actor, not the artefact.
- [ ] **A guardrail that protects a _coupling_ instead of a property.** The test asserts the current implementation
      shape, so the correct fix — a different implementation — fails the guardrail, and the team reverts the correct
      fix. Assert the _property_ the code must have ("this route validates its params"), never the shape ("this route
      calls this function in this order"). When a guardrail blocks a correct fix, the guardrail is the defect.
- [ ] **A guardrail on the wrong side of a seam.** A write-side test protecting a read-side property is green forever and
      catches nothing. Before landing it, ask which side the next instance of the class would appear on.
- [ ] **A check that cannot fail.** Unfalsifiable without a threshold, it produces a paragraph, not a finding, and the
      paragraph is quoted back as coverage. Give it a predicate or delete it.
- [ ] **A popular pattern treated as an invariant.** The ecosystem does it, the last three projects did it, and nobody
      checked whether it is right for this system. State the invariant; if there is not one, it is a preference and it
      belongs in a note.
- [ ] **A default mistaken for a choice.** Nobody decided that strings compare byte-wise, that the clock is
      authoritative, or that a page boundary can repeat a row; the code inherits all three, and the inherited value is
      the one that ships. Whenever two components agree on a value, ask who decided the rule and what the other one
      believes — and remember that the half nobody wrote is still running.
- [ ] **Optimising the metric instead of the code.** Coverage up by writing assertion-free tests; the size budget met by
      moving bytes into a chunk the budget does not measure; the lint ceiling met by adding suppressions. The number is
      a proxy. When the number is satisfied and the defect is not, the work was not done.
- [ ] **A toolchain bug that looks like a project defect.** The analyser miscounts, the bundler misattributes, the type
      checker disagrees with the build, the framework's own migration schematic is broken. **Check the tool version and
      a minimal reproduction before changing project configuration.** The habit of "fixing" the config to match a wrong
      counter is how a real problem gets buried under a workaround.
- [ ] **A change that breaks end-to-end while unit tests stay green.** A green build is not a green e2e. Integration and
      browser-level behaviour — routing, storage, cookies, origin policy, focus, timing — lives outside unit tests by
      construction, as does the platform itself (2.14). Know which end-to-end journeys the change touches and run them
      (or delegate them) rather than inferring correctness from a green unit suite.
- [ ] **Adding a unique index that turns a race into a server error.** The constraint is correct; the _response_ was
      never decided. Decide the domain response first — conflict, idempotent success, or retry — and then add the
      constraint with that translation in place. Adding it without the translation converts a silent race into a
      user-visible error at exactly the wrong moment.
- [ ] **Deleting "dead" code that a test was still exercising.** A single remaining reference is enough to be wrong.
      Search the whole repository including tests, configuration, string-based references, and generated code before
      concluding anything is unused. A deleted export with a test import fails the build — loudly, thankfully — but a
      deleted runtime path with a feature-flag reference fails silently, in production.
- [ ] **A broad ignore list as a patch over a real cause.** Adding a pattern to the ignore file, a lint exclusion, or a
      purging safelist makes the symptom disappear and the problem grow. The ignore list is a statement that "we have
      decided this class of thing is fine"; if that is not true, it is a lie that costs more with every addition. Fix
      the cause or write down the real reason for the exclusion.
- [ ] **A silent skip instead of an honest failure.** A test skipped "temporarily", a check disabled "until the next
      sprint", an error swallowed "until we fix it". A skip that re-enables itself on a future run is a trap; a skip
      that nobody tracks is a lie in the report. Either make it fail honestly, or record it as a known, owned, dated
      debt.
- [ ] **A negative result recorded as a sentence.** "Not applicable" without the mechanism that makes it so, and without
      the condition that would change it, is a hope that decays at the first feature that needs the missing capability.
- [ ] **A measurement that decides nothing.** A benchmark with no decision attached. It costs time, it produces a
      number, and the number changes nobody's plan. Before running anything, name the decision it feeds. If you cannot
      name one, skip it.
- [ ] **Fixing the symptom in the busiest file.** The defect appears in one place, but the cause is a shared helper used
      by thirty. The one-place fix is cheaper, passes the test, and leaves twenty-nine instances. Before choosing a fix
      location, count the call sites.
- [ ] **A refactor bundled with a behaviour change.** Now the diff cannot be reviewed, the guardrail cannot be
      attributed, and a regression cannot be diagnosed. Separate them into two changes; the second one gets its own
      test.
- [ ] **Trusting a green gate on a repository whose gate does not cover the change.** The canonical gate may not include
      the type check, may not include the end-to-end suite, or may skip the package you touched. Check what the gate
      actually runs before quoting it as evidence.
- [ ] **Reporting the plan instead of the result.** A thorough plan that was never executed, or an execution with no
      verification, both produce a report that reads as progress and is not. The report must contain exit codes.
- [ ] **Scope creep disguised as thoroughness.** A run that touches everything produces a diff nobody can review and a
      gate nobody can attribute. Scope in Phase 0, and hold to it.
- [ ] **Letting the open questions rot.** A deferred item that is not re-stated in the report looks abandoned. An
      unanswered question blocks real work, and it is the owner's to answer — surface it clearly, with what it blocks
      and what each answer costs.

---

## Appendix — a one-page checklist for a run

- [ ] Phase 0: repository read, rules recorded, scratch location confirmed, **stack re-researched and what was
      revalidated recorded**, baseline gate run.
- [ ] Scope written down: tracks in, tracks out, depth per track, seam pass in or out.
- [ ] Phase 1: every track's checklist executed, every deep check applied or explicitly ruled inapplicable, every
      finding carries evidence and names its invariant, refuted log maintained including negative results with their
      triggers.
- [ ] Phase 1: seam pass run, with the column recording **which existing check each defect passed**.
- [ ] Phase 2: findings deduplicated, scored, bucketed by a written rule, root causes identified and attributed to
      seams, contradictions resolved, owner questions compiled.
- [ ] Phase 3: waves ordered, dependency graph drawn, work packages complete (verification, new test, guardrail form
      and side, proves-by, rollback, behaviour changes), definition of done per wave, do-not-do list written,
      deferred items marked.
- [ ] Phase 4: guardrail first and proven to fail for the right reason and not as a coupling, then the fix, then
      documentation. Behaviour changes listed per fix. Cross-boundary findings handed back, not fixed. Deferred items
      untouched.
- [ ] Phase 5: clean state, gate re-run, seam pass re-run over changed seams, results table with exit codes, knowledge
      table separating verified from inherited, deltas measured the same way, mess checked, secrets scanned by name,
      owner report written including what could not be verified.
- [ ] Scratch deleted.
