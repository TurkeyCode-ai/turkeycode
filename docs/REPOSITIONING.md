# Repositioning: Phases Are Gates

Status: Decided 2026-07-01. Owner: Chad.

## Thesis

turkeycode turns a confirmed spec into merged code through deterministic verification gates: each phase is sized to what one session can build and one QA pass can prove, and nothing merges past a gate it did not clear.

## Invariants (the durable assets)

1. **The scope methodology.** Correction, not extraction: the spec precipitates out of a reflect-and-be-corrected loop, never an interrogation. `src/prompts/scope.ts` is the surface-agnostic core; `scope-decisions.md` is provenance now and training corpus later.
2. **Hard deterministic gates plus external state.** `gates.ts`, `state.json`, and `quick-check.ts` contain zero LLM judgment. The model cannot talk its way past them. Every run is auditable and CI-runnable. Smarter models are more persuasive when wrong, so this layer gains value as models improve.
3. **Headless packaging.** Unattended runs, token login, non-TTY behavior, and a sandboxed exec host as the target runtime. Interactive harnesses do not compete here.

## What commoditized (retired as pitch)

Parallel subagents, worktree isolation, deterministic pipelines, and context summarization are now table stakes in every serious harness. "Context is its superpower / fewer, larger sessions" is retired as rationale. It was a claim about model limitations; the invariants above are claims about the pipeline. Phases survive the retirement because they were never really about context: they are verification checkpoints and merge gates.

## The reframe (one rule)

A phase is sized to what one QA pass can verifiably prove from the diff and targeted tests. Not sized to context limits. Not sized to human sprint cadence. If QA cannot verify a phase in one pass, the phase is too big.

## Roadmap

| # | Slice | Rationale |
|---|-------|-----------|
| 1 | Decision doc + docs/pitch reframe + the plan prompt | Locks the language everything later quotes; fixes the one prompt where the old pitch shapes runtime output. |
| 2 | Agent SDK rebase: engine adapter behind Spawner, flag-gated | Session resume kills transcript re-embedding (scope loop, qa-fix); prerequisite for the SaaS chat shell. Not cost-motivated: `claude -p` under a Max login is plan-covered, and the spawner already prefers Max login. Hard requirement: the SDK engine keeps Max-login-preferred / API-key-opt-in semantics, and the done-file stays the completion signal. If the Agent SDK cannot use subscription auth, the slice is blocked and the CLI engine stays default. |
| 3 | Scope loop as product | Extract a transport-agnostic driver from `scope-session.ts` (the core in `prompts/scope.ts` is already IO-free); spec the `scope-decisions.md` corpus format; build the chat-shell seam. Depends on slices 1 and 2. |
| 4 | Gates/state hardening | Machine-readable gate results, stable exit codes, GH Actions recipe, document `infraProvidedByEnv()` as the sandbox-host contract. Housekeeping: stale `turkey-enterprise-v3` branding in `deploy/` and skill paths. |

## Non-goals

- Not abandoning phases or the phase loop.
- Not becoming a general agent framework. The pipeline stays opinionated.
- Not building the SaaS UI this cycle. Slice 3 builds the seam, not the shell.
- Not implementing the gVisor host in this repo.
- No changes to gate semantics or the state schema in slice 1.

## Copy rules

Dry, invariants first. Decisions are locked, not proposed. No em-dashes in user-facing copy (README, landing page, CLI output).
