/**
 * Path constants and configuration for turkeycode
 * Phase-based orchestrator model
 */

import {
  CLAUDE_BACKEND,
  PHASE_TIERS,
  getActiveBackend,
  resolveModelForPhase,
} from './agents';

// Base directories
export const STATE_DIR = '.turkey';
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const AUDIT_LOG = `${STATE_DIR}/audit.log`;

// Scope artifacts (interactive "How I Scope" correction loop — runs before research)
export const REFERENCE_DIR = `${STATE_DIR}/reference`;
export const SPECS_FILE = `${REFERENCE_DIR}/specs.md`;
// The living working-model the scope agent rewrites every turn (shown to the human).
export const SCOPE_WORKING_FILE = `${REFERENCE_DIR}/scope-working.md`;
// The decision/correction log emitted on convergence — provenance now, training corpus later.
export const SCOPE_DECISIONS_FILE = `${REFERENCE_DIR}/scope-decisions.md`;
export const SCOPE_DONE = `${REFERENCE_DIR}/scope.done`;
// Persona ("how I scope" operating manual) the scope agent embodies. Project-level
// override lives here; the global default is ~/.turkeycode/persona.md (resolved in
// scope-session.ts, alongside the ~/.turkeycode/ convention used by repos.ts/tickets).
export const PERSONA_PROJECT = `${STATE_DIR}/persona.md`;

// Research artifacts
export const RESEARCH_DONE = `${REFERENCE_DIR}/research.done`;

// Plan artifacts
export const PHASE_PLAN_FILE = `${STATE_DIR}/phase-plan.json`;
export const PLAN_DONE = `${STATE_DIR}/plan.done`;

// Phase build artifacts
export const PHASES_DIR = `${STATE_DIR}/phases`;

// QA artifacts
export const QA_DIR = `${STATE_DIR}/qa`;
export const SCREENSHOTS_DIR = `${STATE_DIR}/screenshots`;

// Review artifacts
export const REVIEWS_DIR = `${STATE_DIR}/reviews`;

// AAR artifacts
export const AAR_DIR = `${STATE_DIR}/aar`;

// Polish artifacts (end-of-build warning cleanup pass)
export const POLISH_DIR = `${STATE_DIR}/polish`;

// Timeouts (in milliseconds)
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const SCOPE_TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per correction turn (interactive)
export const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const PLAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const PHASE_BUILD_TIMEOUT_MS = 90 * 60 * 1000; // 90 minutes (phases are bigger than tickets)
// QA scales with the SIZE OF THE CODEBASE, not the size of the change — which
// is why the build phase already gets 90 minutes and QA got 30. A 21-phase RPG
// sailed through QA on phases 1-8 and hit this ceiling on phase 9: the session
// was cut off at exactly 30m05s, and the phase then failed on a verdict file
// nobody had written. Raising the ceiling is not the whole fix (a cut-off
// session keeps running, and the fallback verdict invents a blocker that
// describes nothing), but a session needing 40 minutes should not die at 30.
export const QA_TIMEOUT_MS = 75 * 60 * 1000; // 75 minutes
export const FIX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const AAR_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (writing markdown summary; large phases need headroom)
export const POLISH_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (repo-wide warning cleanup)

// Retry limits
export const MAX_BUILD_RETRIES = 2;
export const MAX_QA_ATTEMPTS = 5;
export const MAX_QA_ATTEMPTS_WARNINGS_ONLY = 3;
export const MAX_POLISH_ATTEMPTS = 2;
// Transient rate-limit (429) retries before giving up. Credit-exhaustion 429s are
// detected separately and fail fast — this only bounds genuine per-minute limits.
export const MAX_RATE_LIMIT_RETRIES = 5;

// Validation thresholds
export const MIN_SPECS_LENGTH = 200;
export const MIN_PHASE_SCOPE_LENGTH = 20;

// QA strictness - can be overridden via CLI flag
// When true: CLEAN requires zero blockers AND zero warnings
// When false: CLEAN requires zero blockers only (warnings allowed)
export let STRICT_QA = true;

export function setStrictQA(strict: boolean): void {
  STRICT_QA = strict;
}

// Model selection per phase now lives in the agent backend specs
// (src/agents/): phases map to backend-neutral tiers (PHASE_TIERS), each
// backend maps tiers to its own model names, and exact pins go in a
// backend's phaseOverrides (claude pins Fable 5 for build/qa-fix).

/** qa-fix -> TURKEYCODE_MODEL_QA_FIX */
export function phaseModelEnvVar(phase: string): string {
  return 'TURKEYCODE_MODEL_' + phase.toUpperCase().replace(/-/g, '_');
}

/** Each distinct model this run can still use, with the phases that use it. */
export function preflightModels(skipPhases: ReadonlySet<string> = new Set()): Map<string | undefined, string[]> {
  // undefined is a real key: it means the backend's default model, which is all
  // a backend with no tier mappings has, and it still has to be probed.
  const byModel = new Map<string | undefined, string[]>();
  for (const phase of Object.keys(PHASE_MODELS)) {
    if (skipPhases.has(phase)) continue;
    const model = getModelForPhase(phase);
    byModel.set(model, [...(byModel.get(model) ?? []), phase]);
  }
  return byModel;
}

/** A first run that fails preflight has no state to resume. */
export function preflightRerunCommand(hasState: boolean): string {
  return hasState ? 'turkeycode resume' : 'turkeycode run "<your description>"';
}

/**
 * Claude Code's phase → model table, derived from the claude backend spec.
 * Kept exported for callers/tests that reason about the default backend's
 * choices; sessions resolve their model via getModelForPhase.
 */
export const PHASE_MODELS: Record<string, string> = Object.fromEntries(
  Object.entries(PHASE_TIERS).flatMap(([phase, tier]) => {
    const model =
      CLAUDE_BACKEND.models.phaseOverrides?.[phase] ?? CLAUDE_BACKEND.models.tiers[tier];
    return model ? [[phase, model]] : [];
  })
);

/**
 * Get the model for a given phase, in the ACTIVE backend's vocabulary.
 * Returns undefined if no specific model is configured (CLI default model).
 *
 * Env overrides are checked before the backend tables. Running out of credit
 * on ONE model should not mean editing source and rebuilding mid-build:
 *
 *   TURKEYCODE_MODEL_BUILD=opus      one phase
 *   TURKEYCODE_MODEL=sonnet          everything not otherwise set
 *
 * Phase names contain dashes; the env form uppercases and underscores them
 * (qa-fix -> TURKEYCODE_MODEL_QA_FIX).
 */
export function getModelForPhase(phase: string): string | undefined {
  return resolveModelForPhase(getActiveBackend(), phase);
}

// All directories that need to be created
export const ALL_DIRS = [
  STATE_DIR,
  REFERENCE_DIR,
  PHASES_DIR,
  QA_DIR,
  SCREENSHOTS_DIR,
  REVIEWS_DIR,
  AAR_DIR,
  POLISH_DIR
];
