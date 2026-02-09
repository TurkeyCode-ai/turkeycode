/**
 * State management for turkey-enterprise-v3
 * Phase-based orchestrator model
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  ProjectState,
  PhasePlan,
  BuildPhase
} from './types';
import {
  STATE_FILE,
  PHASE_PLAN_FILE,
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
export function saveState(state: ProjectState): void {
  ensureDirectories();
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
 * Reset state for a fresh run
 */
export function resetState(): void {
  if (existsSync(STATE_FILE)) {
    const state = getDefaultState();
    saveState(state);
  }
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
