/**
 * Path constants and configuration for turkey-enterprise-v3
 * Phase-based orchestrator model
 */

// Base directories
export const STATE_DIR = '.turkey';
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const AUDIT_LOG = `${STATE_DIR}/audit.log`;

// Research artifacts
export const REFERENCE_DIR = `${STATE_DIR}/reference`;
export const SPECS_FILE = `${REFERENCE_DIR}/specs.md`;
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

// Timeouts (in milliseconds)
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const PLAN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const PHASE_BUILD_TIMEOUT_MS = 90 * 60 * 1000; // 90 minutes (phases are bigger than tickets)
export const QA_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const FIX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Retry limits
export const MAX_BUILD_RETRIES = 2;
export const MAX_QA_ATTEMPTS = 5;

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
// Maps each phase/sub-phase to the optimal model for cost vs quality
export const PHASE_MODELS: Record<string, string> = {
  // Planning phases — Opus for architecture decisions, Sonnet for extraction
  'research': 'sonnet',
  'plan': 'opus',

  // Build phase — Sonnet is the coding sweet spot
  'build': 'sonnet',

  // QA phases — Haiku for mechanical tasks, Sonnet for reasoning
  'qa-smoke': 'haiku',
  'qa-functional': 'sonnet',
  'qa-visual': 'sonnet',
  'qa-verdict': 'haiku',

  // Fix phases — Opus for debugging (hardest task), Sonnet for compile fixes
  'qa-fix': 'opus',
  'quick-fix': 'sonnet',

  // Post-build — Sonnet for review, Haiku for mechanical summarization
  'code-review': 'sonnet',
  'aar': 'haiku',
};

/**
 * Get the model for a given phase.
 * Returns undefined if no specific model is configured (uses Claude default).
 */
export function getModelForPhase(phase: string): string | undefined {
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
  AAR_DIR
];
