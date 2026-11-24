# Ticket review upgrade: make the deep-tier review catch what an independent reviewer catches

Status: implemented. This is the design record; see the README for current flags. Scope: `run-ticket` deep tier (`src/prompts/ticket-review.ts`,
`src/prompts/ticket-common.ts`, `src/repos.ts`, `src/ticket-orchestrator.ts`).

## Why

The same night, on the same codebase (a legacy system being ported, running in parallel with
the new system and kept in sync by a two-way bridge):

- Two tickets went through the deep tier (opus plan, opus build, **two review → fix rounds**). Both
  reviews returned **0 findings**.
- A fresh reviewer with a targeted brief then found blockers in both:
  - **Bridge ticket.** The change removed a guard so a new record shape would flow to the legacy side.
    The legacy-side producer and consumer, in another repo, had no fields for it. Every record would have
    landed with zero totals. The deep-tier review only read the diff in the ticket's repo.
  - **UI ticket.** The ticket cited the *old* legacy program, and a newer one with an extra field
    exists. The build faithfully implemented the wrong spec, and the review checked it against the
    same wrong spec. It also missed stale data being reused on re-add.
- Four more tickets were built by hand that night with the loop *build → targeted adversarial review →
  fix*. Every review found real defects that a generic "does it do what the ticket says" pass would not:
  - **Bypass path:** a header edit after line entry skipped a rule enforced at line entry.
  - **Literal sentinels:** the legacy system stores literals such as `SPEC ORDER` and `CLUB FEE` in a
    serial-number field. The build treated them as keys, deduplicated them, and created bogus lines.
  - **Revive vs re-insert:** a soft-deleted row coming back was re-inserted, losing its prices.
  - **Ownership signal:** "who created this record" was keyed on a login user instead of a
    deterministic number range.
  - **Concurrency:** two messages for the same record could produce duplicate rows.
  - **A test fixture that encoded the false premise,** so the test passed for the wrong reason.

The difference was not the model or the number of rounds. It was **what the reviewer was told to look
at and doubt**.

## Changes

### 1. Reviewer gets cross-repo context, not just the diff
- `repos.yaml`: allow **related repos** that are read-only for review, each with a role. Examples: the
  bridge producer/consumer repo, the other side of an API contract. These sit alongside today's
  `references`. They differ from them because they are *live code the change must stay compatible
  with*, not research material.
- `ticket-review.ts`: render them in their own block, with an explicit instruction: "if the change
  crosses a boundary (bridge, API, queue, shared table), open the other side and check the contract
  both ways."

### 2. Mandatory citations
Every finding, *and every "verified OK" claim the reviewer relies on*, must cite `file:line` in either
the changed code or a reference. Uncited claims are discarded by the orchestrator. This makes "0
findings" mean "checked", not "skimmed". It also gives the fix session something concrete.

### 3. A standing failure-mode checklist (configurable per manifest)
Add a `review.checklist` list to `repos.yaml`, rendered into the review prompt under "Known failure
modes in this codebase — check each one explicitly and say which apply". Ship a default set:
- **Sentinel / literal values** in legacy fields (placeholder serials, magic codes, `+1` encodings).
- **Both directions of every integration:** what we send, what the other side reads, and the reverse.
- **Field ownership:** when two systems run in parallel, which side owns each field. Does this change
  overwrite the other side's values or echo them back?
- **Bypass paths:** can the rule be skipped by editing a different field, or by a different entry
  point (header vs line, import vs add, reservation vs item)?
- **Re-entry:** re-sent identical message, out-of-order message, soft-deleted row coming back,
  absent vs empty list.
- **Concurrency:** two messages or requests for the same record at once.
- **Tests that encode the premise:** is the fixture data realistic, or does it bake in the
  assumption under review?
- **Constructor / signature churn:** every caller and test that builds the changed class.

Added after dog-fooding, from misses an independent reviewer still caught:
- **Consistency with the rest of the module:** a new clock, helper or rule that only this feature uses.
- **Stale read-modify-write:** an existing slow path (a download, a network call) that saves a whole
  record it read earlier, and can now overwrite the new state.
- **Who else must act:** the UI, the permissions list, the other side of an integration, a
  follow-up ticket.
- **Data source exists:** every table, column or setting the change reads is actually populated
  (seeded, migrated, bridged or editable). Half-populated sources, where the switch is filled in and
  the table it points at is not, are worse than none.
- **Invariants across records:** "one per customer" rules still hold when the decision spans drafts
  or separate requests.
- **Legacy write conventions:** every step of the legacy write path, not just the first assignment.
  This covers sign flips, +1 encodings, and fields a later add/rewrite routine fills in.

### 4. "The ticket may be wrong" is an explicit question
Add to "WHAT TO LOOK FOR": *"Check the ticket's premise against the references. Does the cited
program, field or behaviour actually exist as described? Is there a newer program, a different field,
or a different meaning? A ticket that is wrong about legacy is a `bug` finding, not a pass."* The plan
step should get the same line, so the build doesn't inherit the error.

### 5. Reviewer runs with a fresh, adversarial brief
- The review session must not see the build session's transcript or `build.done` rationale; today it
  receives the plan, which anchors it.
- Pass the plan as "the builder's intent, to be challenged", not as context.
- Give round 2 a **different lens** from round 1. For example, round 1 checks ticket and reference
  fidelity; round 2 checks integration, re-entry and concurrency. Running the same prompt twice
  currently finds the same nothing.

### 6. Local-base, no-push mode (for stacked work that must stay local)
Some teams batch a week of tickets into one PR and keep the stack local until then. Today
`run-ticket` rebases onto `origin/<base>` and pushes (`ticket-orchestrator.ts`, rebase/push step), so
it can't build on an unpushed stack.
- `--base-local <repoPath>=<ref>[,<repoPath>=<ref>]`: cut the ticket branch from a local ref, and
  rebase onto that ref instead of `origin/<base>`.
- `--no-push`: stop after review/fix; leave the branch local; report the branch and SHA for the
  caller to fold in.
- Billing/audit unchanged (wall clock still recorded).

## Measuring it
Use the six tickets above as a regression set. Give each a frozen branch at the pre-review SHA, and
record the defects the independent reviewer found as the expected findings. A review-prompt change
passes if the deep-tier review finds the expected blocker in each, with citations, and doesn't invent
blockers on the cleaned-up versions. Re-run this set whenever `ticket-review.ts` changes.

## Out of scope
- QA phase for `run-ticket` (functional/visual against a running app). It's worth doing, but separate:
  the gaps above were all catchable by reading code.
- Changing tier selection or models.
