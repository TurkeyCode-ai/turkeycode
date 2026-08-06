/**
 * Path constants and configuration for turkeycode
 * Phase-based orchestrator model
 */

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

// Model selection per phase
// Maps each phase/sub-phase to the optimal model for cost vs quality.
// Values are passed to `claude --model`: bare aliases ('opus'/'sonnet'/'haiku')
// float to the latest model in that tier (currently Opus 5 / Sonnet 5 / Haiku 4.5);
// exact IDs pin a specific model.
export const PHASE_MODELS: Record<string, string> = {
  // Scope — Opus: point-of-view-heavy reasoning (reflect, surface forks, catch tensions)
  'scope': 'opus',

  // Planning phases — Opus for architecture decisions, Sonnet for extraction
  'research': 'sonnet',
  'plan': 'opus',

  // Build phase — Fable 5: Anthropic's most capable model, built for exactly this
  // shape of work (long-horizon agentic coding, 60-90 min sessions, self-verification).
  // The build session is where quality is won or lost, so it gets the top tier.
  'build': 'claude-fable-5',

  // QA phases — Haiku for mechanical tasks, Sonnet for reasoning
  'qa-smoke': 'haiku',
  'qa-functional': 'sonnet',
  'qa-visual': 'sonnet',
  'qa-verdict': 'sonnet',

  // Fix phases — Fable 5 for blocker debugging (the hardest coding task in the run,
  // same tier as the build sessions it repairs), Sonnet for compile fixes
  'qa-fix': 'claude-fable-5',
  'quick-fix': 'sonnet',

  // Post-build — Sonnet for review, Haiku for mechanical summarization
  'code-review': 'sonnet',
  'aar': 'sonnet',

  // Polish — Sonnet: warning cleanup is mechanical-ish but fixes need judgment
  'polish': 'sonnet',
};

/**
 * Get the model for a given phase.
 * Returns undefined if no specific model is configured (uses Claude default).
 */
export function getModelForPhase(phase: string): string | undefined {
  // Env overrides, checked before the table. Running out of credit on ONE
  // model should not mean editing source and rebuilding mid-build — which is
  // exactly what happened: a 16-phase run stopped dead at phase 6 on "You've
  // hit your monthly spend limit ... keep using Fable 5 or switch models",
  // and `resume` has no --model flag to answer that with.
  //
  //   TURKEYCODE_MODEL_BUILD=opus      one phase
  //   TURKEYCODE_MODEL=sonnet          everything not otherwise set
  //
  // Phase names contain dashes; the env form uppercases and underscores them
  // (qa-fix -> TURKEYCODE_MODEL_QA_FIX).
  const key = 'TURKEYCODE_MODEL_' + phase.toUpperCase().replace(/-/g, '_');
  const perPhase = process.env[key];
  if (perPhase) return perPhase;

  const global = process.env.TURKEYCODE_MODEL;
  if (global) return global;

  return PHASE_MODELS[phase];
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
