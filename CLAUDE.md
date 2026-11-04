# turkeycode

Phase-based orchestrator for agent-CLI build workflows. Spawns agent sessions per build phase with hard artifact gates and parallel QA. Claude Code is the default backend; Codex CLI, Gemini CLI, OpenCode, and custom `~/.turkeycode/agents.yaml` agents plug in via `--agent` / `TURKEYCODE_AGENT`.

## What This Is

A TypeScript CLI that orchestrates multi-phase software builds:
- **Research** → **Plan** → **Build (1 session per phase)** → **QA (parallel)** → **Review** → **AAR** → **Ship**
- As many coherent build phases as the work needs — 1 for a small ticket, many for a big project — instead of dozens of micro-tickets
- QA functional + visual tests run concurrently
- Blocker fixes run in parallel
- State persists in `.turkey/state.json`

## Key Insight

Scrum tickets exist for human coordination. AI doesn't need them — it works better with bigger, coherent chunks because context is its superpower. Every new session = cold start + lost knowledge. Fewer, larger sessions = better results.

## Run Commands

```bash
# Scope a build into a spec first (interactive correction loop)
turkeycode scope "Project description"

# Start new project. A bare description with no confirmed spec auto-enters the
# scope loop first (TTY only); pass --spec to skip scoping with a ready spec.
turkeycode run "Project description"
turkeycode run "Project description" --spec /path/to/spec.md

# Resume from current state
turkeycode resume

# Check status
turkeycode status

# Reset (start over)
turkeycode reset --force
```

## Flow

```
scope (interactive) → specs.md
  [auto-entered by `run` on a bare description with no confirmed spec, TTY only]
  → research (1 session)
  → plan (1 session → N phases — as many as the work needs)
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

## Scoping (the prompt is the hard part)

The build is only as good as the spec, and the spec is not produced by interrogation —
it **precipitates** out of a reflect-and-be-corrected loop. The agent holds a living
working-model, restates it (over-committed, so there's an edge to knock down), the human
corrects, the agent extends the model and surfaces the next fork **with a recommended
lean**, repeat until corrections peter out and the human starts *confirming* instead of
*amending*. That convergence is "same page," and the spec falls out of it. The engine is
**correction, not extraction** — never a question-bot.

Two surfaces, one shared core (`src/prompts/scope.ts` — `SCOPE_METHOD` + `EMIT_CONTRACT`):
- **CLI**: `turkeycode scope "<description>" [--spec seed.md]` — a terminal
  readline loop (`src/scope-session.ts` — `runScopeSession`). Each turn re-spawns
  `claude --print` with the transcript re-embedded (the spawner has no session-resume),
  and reads back the agent's `scope-working.md` to show the human. `turkeycode run`
  auto-enters this same loop when handed a bare description with no confirmed spec and
  stdin is a TTY; with `--spec`, a prior confirmed scope, a spec-file description, or a
  non-TTY stdin (CI), it skips straight to autonomous research.
- **In-chat skill**: `skills/turkeycode-scope/SKILL.md` — runs the same loop natively as
  the conversation (highest fidelity). The SaaS chat shell will reuse the same core.

On explicit confirmation, scope emits `.turkey/reference/specs.md` (the intent spec, same
shape research writes), `.turkey/reference/scope-decisions.md` (the decision/correction
log — provenance now, training corpus later), and `.turkey/reference/scope.done`. Then
`run` consumes `specs.md` unchanged; greenfield research runs in **augment mode**,
appending a `## Technical Survey` section instead of overwriting the confirmed intent.

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
2. If YES: Run `turkeycode resume` to continue
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
├── spawner.ts        # Runs agent sessions (run, runParallel) — backend-neutral plumbing
├── agents/           # Pluggable agent backends (data-driven specs)
│   ├── types.ts      # AgentBackendSpec, capabilities, PHASE_TIERS, SpawnSessionOptions
│   ├── spawn-config.ts # Pure arg/env builders, classifiers, resolveModelForPhase
│   ├── registry.ts   # Built-ins + ~/.turkeycode/agents.yaml, active-backend global
│   └── claude.ts, codex.ts, gemini.ts, opencode.ts   # Built-in specs
├── gates.ts          # Artifact validation (plan, build, QA gates)
├── state.ts          # State management (phases, not tickets)
├── types.ts          # BuildPhase, PhasePlan, ProjectState
├── prompts/          # Prompt builders for each phase
│   ├── scope.ts      # Shared scope core: SCOPE_METHOD, buildScopePrompt, EMIT_CONTRACT
│   ├── research.ts
│   ├── plan.ts       # Single session → N phases (as many as the work needs)
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
├── godot-capture.ts  # Deterministic game frame capture
└── quick-check.ts    # Fast pre-QA validation
```

## Git Strategy

- Phase branch: `phase-{n}/{slug}` off main
- Build session works directly on phase branch (multiple commits encouraged)
- PR from phase branch → main after QA passes
- No ticket branches. No merge choreography.

## Key Design Decisions

1. **Phase-based, not ticket-based**: N phases (as many as the work needs) instead of dozens of micro-tickets — far fewer sessions, each with enough context to do a good job

2. **Single planning session**: One session produces the full phase plan (not analyze + detail loops)

3. **Fresh-context QA**: QA spawns new agents that haven't seen the build code. Blindness is enforced, not just requested: the visual reviewer runs as `blind: true`, so on backends with `blindFlags` it can't reach user-level MCP servers. A memory server like aimem holds the conversation that built the code. "It never appeared" findings (`kind: "not-shown"`) can't gate when the reviewer skipped captured files, or for a game whose functional QA passed: they stay as warnings. Visual QA fails closed: no report, or a clean report with no frames, is a blocker.

3a. **turkeycode captures games itself**: `src/godot-capture.ts` records the real main scene with Movie Maker through a driver under `.turkey`, so a QA pass needs no capture session and games need no test hooks. Input lives in `capture-timeline.json` next to `project.godot`, which is data, not game code.

4. **Stack-agnostic QA**: Discovers project type and uses appropriate tools

5. **Defer warnings, polish once**: phases gate on blockers only (fast merges); a final repo-wide polish pass drives warnings to zero and re-verifies the build before merging. End state is still ZERO warnings — just batched and verified at the end instead of gated per phase. Use `--strict-phases` for the old per-phase-zero behavior, `--allow-warnings` to skip warning cleanup entirely.

6. **State survives compaction**: Tech context, entities, endpoints persisted in state.json

7. **Pluggable agent backends**: every session runs on an `AgentBackendSpec` (binary, flags, prompt delivery, env policy, billing classifiers, model tiers, capabilities). One backend per run, pinned in state.json; prompts adapt to capabilities (no Task tool → visual QA's blind review runs as a second fresh session). Phase→tier is shared; tier→model is per backend; `TURKEYCODE_MODEL(_PHASE)` overrides both.

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...     # For the claude backend (or use `claude login`)
TURKEYCODE_AGENT=claude           # Agent backend: claude/codex/gemini/opencode or agents.yaml id
TURKEYCODE_MODEL=sonnet           # Global model override (active backend's vocabulary)
TURKEYCODE_MODEL_BUILD=opus       # Per-phase model override (qa-fix -> TURKEYCODE_MODEL_QA_FIX)
TURKEYCODE_USE_API_KEY=1          # Keep the vendor API key instead of the CLI login session
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
npm link  # Makes turkeycode available globally
```
