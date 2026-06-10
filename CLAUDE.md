# turkey-enterprise-v3

Phase-based orchestrator for Claude Code build workflows. Spawns Claude sessions per build phase with hard artifact gates and parallel QA.

## What This Is

A TypeScript CLI that orchestrates multi-phase software builds:
- **Research** → **Plan** → **Build (1 session per phase)** → **QA (parallel)** → **Review** → **AAR** → **Ship**
- 2-5 coherent build phases instead of dozens of micro-tickets
- QA functional + visual tests run concurrently
- Blocker fixes run in parallel
- State persists in `.turkey/state.json`

## Key Insight

Scrum tickets exist for human coordination. AI doesn't need them — it works better with bigger, coherent chunks because context is its superpower. Every new session = cold start + lost knowledge. Fewer, larger sessions = better results.

## Run Commands

```bash
# Start new project
turkey-enterprise-v3 run "Project description" --spec /path/to/spec.md

# Resume from current state
turkey-enterprise-v3 resume

# Check status
turkey-enterprise-v3 status

# Reset (start over)
turkey-enterprise-v3 reset --force
```

## Flow

```
research (1 session)
  → plan (1 session → 2-5 phases)
  → PHASE LOOP:
      build (1 session, full phase scope)
      → quick check
      → QA (smoke + functional||visual + verdict)   [blockers-only gate by default]
      → fix loop if needed
      → code review
      → AAR (opt-in: --aar)
      → merge to main
      → next phase
  → POLISH PASS (default): repo-wide warning cleanup → re-verify build → merge
```

## Phase Model

Each build phase is one Claude session that builds a coherent chunk of the project:
- Phase 1 is always foundation (project setup, core infrastructure)
- Each phase has scope, deliverables, and acceptance criteria
- Phases build on each other (context from prior phases carried forward)
- 60-90 minute target per phase build session

## QA Pipeline

Each phase goes through:
1. **Quick smoke check** — fast sanity test
2. **Smoke test** — app starts, pages load, no dead elements
3. **Functional test** + **Visual test** — run in parallel
4. **Verdict** — CLEAN or NEEDS_FIX
5. **Fix loop** — if NEEDS_FIX, parallel blocker fixes, then re-test (max 3 attempts)

### Warning policy (three modes)

The end state is always ZERO warnings — the question is *when* they get fixed.

- **DEFER (default)** — phases gate on **blockers only**, so a functionally-correct phase merges immediately without stalling on lint/style. Warnings accumulate, then a single **polish pass** after the last phase fixes them all coherently across the repo and **re-verifies the build** (deterministic quick-check) before merging. The re-verify is what keeps "perfect" honest — a cleanup that breaks compilation/boot is reverted, never merged. Stubborn warnings never fail the run (the build already passed functional QA per phase); they're logged and the verified-safe cleanup is merged anyway.
- **`--strict-phases`** — old behavior: every phase gated on ZERO warnings (blockers AND warnings), no polish pass.
- **`--allow-warnings` / `-w`** — blockers only per phase, warnings left as-is, no polish.

Why defer-by-default: phases merge faster, and one repo-wide pass fixes a lint rule everywhere at once (better than each phase patching its slice). Warning fixes can be latent bugs, so the polish session treats them as real and never mass-suppresses.

## After Context Clear / Compact

**IMPORTANT:** If context was cleared, check for existing workflow state:

1. Check if `.turkey/state.json` exists in the working directory
2. If YES: Run `turkey-enterprise-v3 resume` to continue
3. If NO: This is a fresh start

The state file tracks:
- Current phase (research/plan/build/qa/review)
- Current build phase number
- Build phases with status, attempts, verdicts
- Completed phases
- QA attempts
- Tech context (stack, entities, endpoints, pages)

## Project Structure

```
src/
├── index.ts          # CLI entry point
├── orchestrator.ts   # Main loop: research → plan → phase loop
├── spawner.ts        # Runs Claude sessions (run, runParallel)
├── gates.ts          # Artifact validation (plan, build, QA gates)
├── state.ts          # State management (phases, not tickets)
├── types.ts          # BuildPhase, PhasePlan, ProjectState
├── prompts/          # Prompt builders for each phase
│   ├── research.ts
│   ├── plan.ts       # Single session → 2-5 phases
│   ├── build.ts      # Full phase scope prompt
│   ├── qa-smoke.ts
│   ├── qa-functional.ts
│   ├── qa-visual.ts
│   ├── qa-verdict.ts
│   ├── qa-fix.ts
│   ├── code-review.ts
│   ├── aar.ts
│   └── polish.ts     # Repo-wide warning cleanup (defer-warnings pass)
├── github.ts         # GitHub/git integration
├── jira.ts           # Jira integration
├── audit.ts          # Audit log (phase events)
├── constants.ts      # Timeouts, paths
└── quick-check.ts    # Fast pre-QA validation
```

## Git Strategy

- Phase branch: `phase-{n}/{slug}` off main
- Build session works directly on phase branch (multiple commits encouraged)
- PR from phase branch → main after QA passes
- No ticket branches. No merge choreography.

## Key Design Decisions

1. **Phase-based, not ticket-based**: 2-5 phases instead of 62 tickets = ~20 sessions instead of 118+

2. **Single planning session**: One session produces the full phase plan (not analyze + detail loops)

3. **Fresh-context QA**: QA spawns new agents that haven't seen the build code

4. **Stack-agnostic QA**: Discovers project type and uses appropriate tools

5. **Defer warnings, polish once**: phases gate on blockers only (fast merges); a final repo-wide polish pass drives warnings to zero and re-verifies the build before merging. End state is still ZERO warnings — just batched and verified at the end instead of gated per phase. Use `--strict-phases` for the old per-phase-zero behavior, `--allow-warnings` to skip warning cleanup entirely.

6. **State survives compaction**: Tech context, entities, endpoints persisted in state.json

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...     # Required
GH_TOKEN=ghp_...                  # For private repos
GITHUB_OWNER=username-or-org      # For auto-creating repos
JIRA_HOST=company.atlassian.net   # For Jira integration (REST API)
JIRA_EMAIL=you@example.com        # Jira account email
JIRA_TOKEN=...                    # Jira API token (from id.atlassian.com)
JIRA_PROJECT=PROJ                 # Jira project key (optional - auto-created if not set)
```

## Build & Test

```bash
npm install
npm run build
npm link  # Makes turkey-enterprise-v3 available globally
```
