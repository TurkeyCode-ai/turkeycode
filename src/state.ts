/**
 * State management for turkeycode
 * Phase-based orchestrator model
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  ProjectState,
  PhasePlan,
  BuildPhase
} from './types';
import {
  STATE_FILE,
  PHASE_PLAN_FILE,
  PLAN_DONE,
  PHASES_DIR,
  QA_DIR,
  REVIEWS_DIR,
  POLISH_DIR,
  RESEARCH_DONE,
  ALL_DIRS
} from './constants';

/**
 * Get the default initial state
 */
export function getDefaultState(): ProjectState {
  return {
    projectName: '',
    projectDescription: '',
    specFile: '',
    workDir: process.cwd(),

    currentPhase: 'init',
    currentStep: '',

    currentBuildPhaseNumber: 0,
    buildPhases: [],
    completedPhases: [],

    tech: {},
    entities: [],
    endpoints: [],
    uiPages: [],
    knownIssues: [],

    qaAttempts: 0,

    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString()
  };
}

/**
 * Ensure all required directories exist
 */
export function ensureDirectories(): void {
  for (const dir of ALL_DIRS) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Load state from disk, or return default state if not found
 */
export function loadState(): ProjectState {
  if (existsSync(STATE_FILE)) {
    try {
      const content = readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(content) as ProjectState;
      return state;
    } catch (err) {
      console.error(`Warning: Could not parse ${STATE_FILE}, using default state`);
      return getDefaultState();
    }
  }
  return getDefaultState();
}

/**
 * Save state to disk
 */
/**
 * The QA loop counts attempts and verdicts on the run (`state.qaAttempts`,
 * `state.lastQaVerdict`), and those reset when the run moves to the next
 * phase. Copy them onto the phase under QA so its record keeps them after the
 * run has moved on: `turkeycode status` reports per phase.
 */
export function recordQaOnPhase(state: ProjectState): void {
  const phase = state.buildPhases.find(p => p.number === state.currentBuildPhaseNumber);
  if (!phase || (phase.status !== 'qa' && phase.status !== 'fixing')) return;
  phase.qaAttempts = state.qaAttempts;
  if (state.lastQaVerdict) phase.lastQaVerdict = state.lastQaVerdict;
}

export function saveState(state: ProjectState): void {
  ensureDirectories();
  recordQaOnPhase(state);
  state.lastUpdatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Initialize a new project state
 */
export function initState(description: string, options: {
  jiraProject?: string;
  githubRepo?: string;
  specFile?: string;
} = {}): ProjectState {
  ensureDirectories();

  const state: ProjectState = {
    ...getDefaultState(),
    projectName: description.split(' ').slice(0, 3).join('-').toLowerCase(),
    projectDescription: description,
    specFile: options.specFile || '',
    jiraProject: options.jiraProject,
    githubRepo: options.githubRepo,
    currentPhase: 'init',
    startedAt: new Date().toISOString()
  };

  saveState(state);
  return state;
}

/**
 * Load phase plan from file
 */
export function loadPhasePlan(): PhasePlan | null {
  if (!existsSync(PHASE_PLAN_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(PHASE_PLAN_FILE, 'utf-8');
    return JSON.parse(content) as PhasePlan;
  } catch (err) {
    console.error(`Warning: Could not parse ${PHASE_PLAN_FILE}`);
    return null;
  }
}

/**
 * Save phase plan to file
 */
export function savePhasePlan(plan: PhasePlan): void {
  ensureDirectories();
  writeFileSync(PHASE_PLAN_FILE, JSON.stringify(plan, null, 2));
}

/**
 * Get a specific build phase from state
 */
export function getBuildPhase(state: ProjectState, phaseNumber: number): BuildPhase | null {
  return state.buildPhases.find(p => p.number === phaseNumber) || null;
}

/**
 * Advance to the next build phase
 */
export function advancePhase(state: ProjectState): boolean {
  const currentPhase = state.buildPhases.find(p => p.number === state.currentBuildPhaseNumber);
  if (currentPhase) {
    state.completedPhases.push({
      number: currentPhase.number,
      name: currentPhase.name,
      completedAt: new Date().toISOString(),
      buildTime: currentPhase.buildTime || '',
      qaTime: currentPhase.qaTime,
      totalTime: currentPhase.totalTime,
      prNumber: currentPhase.prNumber,
      aarPath: `docs/aar/phase-${currentPhase.number}.md`
    });
  }

  state.currentBuildPhaseNumber++;
  state.qaAttempts = 0;
  state.lastQaVerdict = undefined;
  state.lastQaFindings = undefined;

  return state.currentBuildPhaseNumber <= state.buildPhases.length;
}

/**
 * Remove everything a run leaves behind that the NEXT run would trust: the plan
 * and its done marker, per-phase build markers, QA verdicts, reviews, polish
 * notes and the research marker. Left in place, a later `run --spec <new>` sees
 * "plan gate already passes", skips planning and builds the previous spec's
 * phases. The spec and scope files, the persona, the audit log and screenshots
 * are kept: they are inputs or history, not gates.
 */
export function clearRunArtifacts(workDir: string = process.cwd()): void {
  for (const path of [PHASE_PLAN_FILE, PLAN_DONE, RESEARCH_DONE]) {
    try { rmSync(join(workDir, path), { force: true }); } catch { /* ignore */ }
  }
  for (const dir of [PHASES_DIR, QA_DIR, REVIEWS_DIR, POLISH_DIR]) {
    try { rmSync(join(workDir, dir), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Stable fingerprint of a spec, so a run can tell its plan was made from another one. */
export function specFingerprint(spec: string): string {
  return createHash('sha256').update(spec.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/**
 * Whether the plan on disk belongs to a different job than the one being started.
 * Two cases: the plan was made from a different spec (fingerprints differ), or
 * the state is brand new ('init') yet a plan is already there, which is what a
 * reset from a version before clearRunArtifacts leaves behind. A plan with no
 * recorded fingerprint on a run that is under way is trusted, so resuming a run
 * started by an older version keeps working.
 */
export function planIsLeftover(
  state: Pick<ProjectState, 'currentPhase' | 'planSpecHash'>,
  planExists: boolean,
  specHash: string | undefined
): boolean {
  if (!planExists) return false;
  if (state.currentPhase === 'init') return true;
  return Boolean(specHash && state.planSpecHash && specHash !== state.planSpecHash);
}

/**
 * Reset state to initial values, and clear the previous run's plan and markers
 */
export function resetState(): void {
  if (existsSync(STATE_FILE)) {
    const state = getDefaultState();
    saveState(state);
  }
  clearRunArtifacts();
}

/**
 * Check if we can resume from existing state
 */
export function canResume(): boolean {
  if (!existsSync(STATE_FILE)) {
    return false;
  }

  const state = loadState();
  return state.currentPhase !== 'init' && state.currentPhase !== 'done';
}
