/**
 * `turkeycode status` printed "QA attempts: 0" for a phase that took two QA
 * attempts: the count lived only on the run and was reset when the run moved
 * to the next phase.
 */
import { describe, it, expect } from 'vitest';
import { getDefaultState, recordQaOnPhase } from '../state';
import { BuildPhase, ProjectState } from '../types';

function phase(number: number, status: BuildPhase['status']): BuildPhase {
  return {
    number, name: `Phase ${number}`, scope: '', deliverables: [], acceptanceCriteria: [],
    prerequisites: [], specContext: '', status, buildAttempts: 1, qaAttempts: 0,
  };
}

function stateWith(...phases: BuildPhase[]): ProjectState {
  return { ...getDefaultState(), buildPhases: phases, currentBuildPhaseNumber: 1 };
}

describe('recordQaOnPhase', () => {
  it('copies the live attempt count and verdict onto the phase under QA', () => {
    const state = stateWith(phase(1, 'qa'), phase(2, 'planned'));
    state.qaAttempts = 2;
    state.lastQaVerdict = 'NEEDS_FIX';
    recordQaOnPhase(state);
    expect(state.buildPhases[0].qaAttempts).toBe(2);
    expect(state.buildPhases[0].lastQaVerdict).toBe('NEEDS_FIX');
    expect(state.buildPhases[1].qaAttempts).toBe(0);
  });

  it('follows a rate-limited attempt being un-counted', () => {
    const state = stateWith(phase(1, 'qa'));
    state.qaAttempts = 2;
    recordQaOnPhase(state);
    state.qaAttempts = 1;
    recordQaOnPhase(state);
    expect(state.buildPhases[0].qaAttempts).toBe(1);
  });

  it('keeps a finished phase\'s record when the run resets for the next phase', () => {
    const state = stateWith(phase(1, 'qa'), phase(2, 'planned'));
    state.qaAttempts = 2;
    state.lastQaVerdict = 'CLEAN';
    recordQaOnPhase(state);

    // What the orchestrator does after QA: merge, mark done, advance, reset.
    state.buildPhases[0].status = 'merging';
    recordQaOnPhase(state);
    state.buildPhases[0].status = 'done';
    state.currentBuildPhaseNumber = 2;
    state.qaAttempts = 0;
    state.lastQaVerdict = undefined;
    state.buildPhases[1].status = 'building';
    recordQaOnPhase(state);

    expect(state.buildPhases[0].qaAttempts).toBe(2);
    expect(state.buildPhases[0].lastQaVerdict).toBe('CLEAN');
    expect(state.buildPhases[1].qaAttempts).toBe(0);
    expect(state.buildPhases[1].lastQaVerdict).toBeUndefined();
  });

  it('does not wipe a recorded verdict while the next attempt has none yet', () => {
    const state = stateWith(phase(1, 'qa'));
    state.buildPhases[0].lastQaVerdict = 'NEEDS_FIX';
    state.qaAttempts = 2;
    state.lastQaVerdict = undefined;
    recordQaOnPhase(state);
    expect(state.buildPhases[0].lastQaVerdict).toBe('NEEDS_FIX');
  });

  it('does nothing before a plan exists', () => {
    const state = getDefaultState();
    expect(() => recordQaOnPhase(state)).not.toThrow();
  });
});
