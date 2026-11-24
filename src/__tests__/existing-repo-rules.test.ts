/**
 * New-project build rules must not be read as orders on an existing repository.
 *
 * Regression seen on client services: the web-api rule "Implement GET /health"
 * made three separate runs add an unauthenticated health route to a production
 * gateway whose spec said "Do not add a health endpoint".
 */
import { describe, it, expect } from 'vitest';
import { buildBuildPhasePrompt, existingRepoRules } from '../prompts/build';
import type { BuildPhase, ProjectState } from '../types';

const base = {
  tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], completedPhases: [],
  projectType: 'web-api',
} as unknown as ProjectState;

const phase = {
  number: 1, name: 'Add a read', scope: 'Add one read-only route to the gateway.',
  prerequisites: [], deliverables: ['The route'], acceptanceCriteria: ['It answers'],
} as unknown as BuildPhase;

describe('existingRepoRules', () => {
  it('says nothing for a project with no baseline (a new build)', () => {
    expect(existingRepoRules({})).toBe('');
  });

  it('demotes the new-project rules on a repository that existed before the run', () => {
    const text = existingRepoRules({ baselineSha: 'abc123' });
    expect(text).toMatch(/EXISTED BEFORE THIS RUN/);
    expect(text).toMatch(/no health endpoint/);
    expect(text).toMatch(/no build script/);
    expect(text).toMatch(/spec's own rules and this repository's existing conventions win/);
  });
});

describe('the build prompt', () => {
  it('carries the block after the type rules for an existing web-api repository', () => {
    const state = { ...base, baselineSha: 'abc123' };
    const prompt = buildBuildPhasePrompt(state, phase);
    const rule = prompt.indexOf('Health endpoint');
    const block = prompt.indexOf('EXISTED BEFORE THIS RUN');
    expect(rule).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(rule);
  });

  it('leaves a new project\'s prompt as it was', () => {
    const state = { ...base };
    expect(buildBuildPhasePrompt(state, phase)).not.toMatch(/EXISTED BEFORE THIS RUN/);
  });
});
