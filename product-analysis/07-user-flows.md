# 07 — User Flows

Flows use Mermaid where they clarify branching. Alternate/error paths are explicit. Companion to
[08-screen-and-page-specification.md](08-screen-and-page-specification.md).

---

## 1. Registration

```mermaid
flowchart TD
    A[Landing] --> B[Sign Up form: email, password, confirm, display name]
    B --> C{Server validation}
    C -- invalid --> B
    C -- email exists --> D[Validation error shown inline] --> B
    C -- ok --> E{Email verification enabled?}
    E -- yes --> F[Verification screen] --> G
    E -- no --> G[Onboarding: no tenant detected]
```

## 2. Login

```mermaid
flowchart TD
    A[Login form] --> B{Credentials valid?}
    B -- no --> A
    B -- yes --> C{Accessible tenants}
    C -- none --> D[First-tenant onboarding]
    C -- one --> E[Tenant home]
    C -- many --> F[Tenant selector / last selected]
    A -. session failure later .-> G[Clear auth state → keep return URL → redirect once]
```

## 3. First Tenant creation

```mermaid
flowchart TD
    A[Welcome / create workspace] --> B[Enter workspace name]
    B --> C[Choose plan: Free $0]
    C --> D[Mock checkout - no real payment data]
    D --> E[Confirmation]
    E --> F[Tenant created · user = OWNER]
    F --> G[Tenant dashboard, empty state: create first project]
```

Error path: checkout step cannot fail permanently (mock); a retry affordance is still provided.

## 4. Mock checkout

Covered in flow 3 (steps C–E). Constraint: billing boundary isolated; replacing mock with a real provider must not touch
domain code (user-flows §3.1).

## 5. First Project creation

```mermaid
flowchart TD
    A[Tenant dashboard: Create Project] --> B[Form: name, key, description?]
    B --> C{Key valid + unique in tenant?}
    C -- no --> B
    C -- yes --> D[Atomic seed: types TASK/BUG/STORY · statuses TODO/IN_PROGRESS/IN_REVIEW/REOPENED/DONE · default board TODO+REOPENED / IN_PROGRESS / IN_REVIEW / DONE · defaultStatus=TODO · defaultBoard set]
    D --> E[Project opens · empty states with CTAs]
```

Failure path: if seeding fails, the Project is rolled back/not surfaced (no partially initialized Projects).

## 6. First Task creation

```mermaid
flowchart TD
    A[Create Task CTA from Overview/Board/Tasks] --> B[Form: title required · status preselected TODO · type default TASK]
    B --> C{Valid?}
    C -- no --> B
    C -- yes --> D[POST · server assigns PROJ-n number]
    D --> E[Task detail opens or card appears on board]
```

## 7. Task editing

```mermaid
flowchart TD
    A[Task page · click field to edit] --> B[Edit single field · Save]
    B --> C[PATCH with observed version]
    C --> D{Version match?}
    D -- yes --> E[Show saved value · bump version]
    D -- conflict --> F[Conflict UI: your change vs current · Keep mine / Reload & redo / Cancel]
    F --> G[Audit event records resolution]
```

Never silently overwrite (user-flows §11).

## 8. Task commenting

Add comment (Editor+) → renders Markdown with author display name. Edit/delete per permission rules. If author deleted
later, snapshot name persists.

## 9. Label creation/reuse

```mermaid
flowchart TD
    A[Label input on task] --> B[Type text]
    B --> C{Case-insensitive match exists?}
    C -- yes --> D[Suggest existing label · selecting links it]
    C -- no --> E[Offer Create new label]
    E --> F[Label added to project list + task]
```

## 10. Board usage

Open Board → loads user's preferred board for the project (fallback: project default board) → columns render
(multi-status columns grouped) → drag card:

- destination column has 1 status → apply directly;
- multiple statuses → prompt status choice;
- optimistic move, rollback + toast on failure. Invalid column references (deleted status) are not rendered on view;
  visible red in board editor.

## 11. Sprint creation

PAdmin+ opens Sprints → "Create Sprint" → name (+ optional dates) → created as FUTURE. Validation: if both dates
present, `endDate >= startDate`.

## 12. Sprint start

```mermaid
flowchart TD
    A[FUTURE sprint · Start Sprint button PAdmin+] --> B{startDate set?}
    B -- no --> C[startDate = now]
    B -- yes --> D[preserve configured startDate]
    C --> E[status = ACTIVE]
    D --> E
    E --> F[Sprint board available for this sprint]
```

## 13. Sprint completion

```mermaid
flowchart TD
    A[ACTIVE sprint · Complete Sprint PAdmin+] --> B{endDate set?}
    B -- no --> C[endDate = now]
    B -- yes --> D[preserve endDate]
    C --> E{Unfinished tasks exist?}
    D --> E
    E -- yes --> F[Dialog: move unfinished to Backlog / choose future sprint]
    E -- no --> G[status = COMPLETED]
    F --> G
```

Note: passing `endDate` alone never triggers this flow (manual only — final decision).

## 14. Invitation

```mermaid
flowchart TD
    A[Members page · Invite] --> B[Enter email + role]
    B --> C{Already active member?}
    C -- yes --> D[Info: already a member]
    C -- no --> E{Pending invitation exists?}
    E -- yes --> F[Offer Resend instead]
    E -- no --> G[Create membership PENDING invitation · store token hash · invitedBy/invitedOn=now]
    G --> H[Send email: inviter, target, role, expiry, accept button]
```

## 15. Invitation acceptance

```mermaid
flowchart TD
    A[Open /invite/:token] --> B{Token hash found?}
    B -- no --> X[Invalid link message]
    B -- yes --> C{State check}
    C -- REVOKED --> Y[This invitation is no longer valid]
    C -- DECLINED --> Z[The invitation was declined]
    C -- derived-expired --> W[This invitation has expired · ask admin for new one]
    C -- PENDING+valid --> D{Logged in?}
    D -- no --> E{Account exists for email?}
    E -- yes --> F[Login with that email → resume acceptance]
    E -- no --> G[Register pre-filled → resume acceptance]
    D -- yes --> H{Session email == invited email?}
    H -- no --> I[Ask to switch/authenticate with invited identity]
    H -- yes --> J[Accept: membership ACTIVE · invitation data removed]
    J --> K[Land in relevant Tenant/Project context]
```

Security rule: never silently attach access to the wrong account.

## 16. Invitation resend

Resend replaces token (old link dead), updates invitedBy/invitedOn, sets PENDING, sends new email. Only possible while
not yet accepted.

## 17. Access revocation

Admin revokes ACTIVE membership → status ACCESS_REVOKED. If an invitation was pending: invitation becomes EXPIRED and
cleared. User next visiting sees "Your access to \<Tenant\> has expired."

## 18. Access restoration

ACCESS_REVOKED → ACTIVE by admin → user sees "Your access … has been restored." Exception: a user who never accepted
their invitation cannot be restored directly — they must accept explicitly.

## 19. Project member removal / re-addition

Remove → Project membership gone; Tenant membership, Tasks, Comments, snapshots untouched. Re-add → history reattaches
automatically (it was never detached); role granted determines edit rights again.

## 20. User deletion

```mermaid
flowchart TD
    A[Admin deletes User] --> B[Live access removed · memberships removed]
    B --> C[Tasks remain: assigneeId→null + assigneeSnapshot kept · reporter/creator same]
    B --> D[Comments remain: authorId→null + authorSnapshot kept]
    B --> E[Audit actor snapshots kept]
    C --> F[Search still finds records via snapshot names]
```

## 21. Status deletion

```mermaid
flowchart TD
    A[PAdmin deletes Status] --> B{Used by tasks?}
    B -- yes --> C[Replacement mandatory · show affected count]
    C --> D[Apply replacement to all affected tasks AND board column references]
    D --> H[Delete status]
    B -- no --> E{Referenced by boards?}
    E -- yes --> F[Warn listing boards · options Replace / Delete anyway / Cancel]
    F -- delete anyway --> G[Delete · boards hide missing column · editor marks red]
    F -- replace --> D
    E -- no --> H
```

Guard: the last remaining status cannot be deleted (default status needs a target); deleting the default status requires
choosing a new default replacement.

## 22. Project archive

Settings → Danger Zone → Archive → confirm → ARCHIVED (read-only). Restore returns to ACTIVE (unless archived via Tenant
archive — then restore happens through Tenant restore).

## 23. Project deletion

Danger Zone → Delete → warning enumerating everything destroyed → type key/name to confirm → DELETION_PENDING + grace
period → cancellable → permanent aggregate deletion. Direct URLs afterwards resolve to Not Found without leaking
existence.
