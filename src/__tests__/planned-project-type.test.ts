import { describe, it, expect } from 'vitest';
import { adoptPlannedProjectType } from '../detect-project-type';
import { buildPlanPrompt } from '../prompts/plan';
import type { ProjectState, ProjectType } from '../types';

const guessed = (type: ProjectType) => ({ projectType: type, projectTypeGuessed: true });

describe('adoptPlannedProjectType', () => {
  it('replaces a greenfield guess with what the planner says it is building', () => {
    const state = guessed('web-fullstack');
    expect(adoptPlannedProjectType(state, 'web-frontend')).toBe('web-frontend');
    expect(state).toEqual({ projectType: 'web-frontend', projectTypeGuessed: false });
  });

  it('confirms a correct guess without reporting a change, and only once', () => {
    const state = guessed('cli');
    expect(adoptPlannedProjectType(state, 'cli')).toBeNull();
    expect(state.projectTypeGuessed).toBe(false);
    // A later re-plan cannot flip a type that is no longer a guess.
    expect(adoptPlannedProjectType(state, 'web-api')).toBeNull();
    expect(state.projectType).toBe('cli');
  });

  it('never overrides a type that was forced or detected from real files', () => {
    const state: { projectType?: ProjectType; projectTypeGuessed?: boolean } = { projectType: 'legacy' };
    expect(adoptPlannedProjectType(state, 'web-frontend')).toBeNull();
    expect(state.projectType).toBe('legacy');
  });

  it('keeps the guess when the plan gives nothing usable', () => {
    for (const planned of [undefined, null, 42, '', 'spa', 'unknown', '<what you are actually building>']) {
      const state = guessed('web-fullstack');
      expect(adoptPlannedProjectType(state, planned)).toBeNull();
      expect(state).toEqual({ projectType: 'web-fullstack', projectTypeGuessed: true });
    }
  });
});

describe('plan prompt', () => {
  it('asks the planner to state the project type, with frontend-only spelled out', () => {
    const prompt = buildPlanPrompt({ projectDescription: 'a calculator' } as ProjectState, false);
    expect(prompt).toContain('"projectType":');
    expect(prompt).toContain('web-frontend (runs in the browser with no server of its own');
  });
});
