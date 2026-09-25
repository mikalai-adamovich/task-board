# 04 — User Personas

**Key distinction:** a _persona_ describes a person's job and needs; an _authorization role_ describes what the system
lets them do. One persona may hold different roles in different Tenants/Projects; one role serves many personas. Do not
map personas 1:1 to roles.

---

## 1. Personas

### P1 — Maya, Solo Founder / First Tenant Owner

- **Context:** Creates the first Tenant, becomes Tenant Owner by definition. 1–5 person startup.
- **Needs:** Register → workspace → project → first task in minutes; zero admin ceremony; free plan.
- **Pain points to avoid:** setup wizards, required configuration before first task.
- **Typical roles:** Tenant Owner + Project Admin + Editor everywhere (initially the only member).

### P2 — Daniel, Engineering Team Lead

- **Context:** Leads 5–15 developers inside a Tenant owned by someone else.
- **Needs:** Plan sprints, keep board truthful, see who is blocked; start/complete sprints; manage project members.
- **Frustrations (from research):** slow boards, permission requests for routine actions.
- **Typical roles:** Project Admin (or Editor if admins are centralized); Tenant Member.

### P3 — Aisha, Product Manager / Stakeholder

- **Context:** Writes stories, prioritizes backlog, reports status upward. Not deeply technical about tooling.
- **Needs:** Create/edit tasks and comments, filter "my open items", share URLs to exact filtered views.
- **Anti-need:** JQL-style query languages, workflow configuration.
- **Typical roles:** Editor; sometimes Viewer on projects she only observes.

### P4 — Tomás, Individual Contributor (Developer)

- **Context:** Works from the sprint board daily; hates process overhead.
- **Needs:** Keyboard-fast task creation/moves, inline field editing, comments, clear conflict feedback when two people
  edit one task.
- **Frustrations (research):** five-click simple actions, silent overwrites
  ([HN](https://news.ycombinator.com/item?id=48437609)).
- **Typical roles:** Editor.

### P5 — Elena, QA Engineer

- **Context:** Files bugs, reopens tasks, tracks regressions via labels.
- **Needs:** Fast bug creation with type=BUG, REOPENED status visible on the default board (it shares the TODO column),
  label reuse ("bug" resolves to existing "Bug").
- **Typical roles:** Editor.

### P6 — Grace, Engineering Manager / Tenant Admin

- **Context:** Oversees several Projects; does not work in them daily.
- **Needs:** Cross-project visibility, invite/remove people, restore access, audit who changed what; intervene in any
  Project without being a member of each.
- **Typical roles:** Tenant Admin (Tenant-level authority without per-Project membership — matches requirements §8.1).

### P7 — Omar, External Stakeholder / Client Viewer

- **Context:** Reads progress, never writes. Possibly outside the company.
- **Needs:** Read-only access that cannot accidentally mutate anything; clean read-only UI without disabled-button
  noise.
- **Typical roles:** Viewer (strictly read-only — final product decision).

### P8 — Priya, New Invited Member

- **Context:** Receives invitation email; may or may not already have an account.
- **Needs:** Understand _who_ invited her, _where_ she is going, _what_ she can do; accept in one click; land directly
  in the right workspace.
- **Failure modes to design for (research:
  [sequenzy](https://www.sequenzy.com/blog/how-to-create-team-invitation-emails-saas),
  [bentonow](https://bentonow.com/posts/user-invitation-email-best-practices)):** expired link, revoked link, wrong
  account logged in, duplicate-account dead ends.

## 2. Persona ↔ role mapping

| Persona             | Tenant role               | Typical Project role(s)            |
| ------------------- | ------------------------- | ---------------------------------- |
| Maya (founder)      | OWNER                     | PROJECT_ADMIN                      |
| Daniel (team lead)  | MEMBER                    | PROJECT_ADMIN or EDITOR            |
| Aisha (PM)          | MEMBER                    | EDITOR (VIEWER elsewhere)          |
| Tomás (dev)         | MEMBER                    | EDITOR                             |
| Elena (QA)          | MEMBER                    | EDITOR                             |
| Grace (eng manager) | ADMIN                     | _(none needed — tenant authority)_ |
| Omar (stakeholder)  | MEMBER                    | VIEWER                             |
| Priya (new joiner)  | MEMBER (after acceptance) | assigned at invitation time        |

## 3. Implications for the product

1. The **first-run experience must be optimized for Maya** (P1): no step may require knowledge she doesn't have yet.
2. **Daily-use experience must be optimized for Tomás/Elena** (P4/P5): speed, inline editing, keyboard paths, honest
   conflict handling.
3. **Administration must be legible to Grace** (P6): one permission matrix, audit trail, no hidden effective-permission
   logic.
4. **Viewer UX (Omar)** should hide write affordances entirely rather than show disabled controls everywhere (user-flows
   doc §32).
5. **Invitation UX (Priya)** must handle existing-account vs new-account routing explicitly — never show "email already
   registered" as a dead end.
