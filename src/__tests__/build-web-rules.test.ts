import { describe, it, expect } from 'vitest';
import { buildBuildPhasePrompt } from '../prompts/build';

const phase = { number: 1, name: 'Core', scope: 's', deliverables: ['a'], acceptanceCriteria: ['b'], prerequisites: [] } as any;
const stateFor = (projectType: string) =>
  ({ projectType, tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], completedPhases: [] } as any);

describe('web build rules', () => {
  // Issue #34: inline on* handlers in App Router Server Components pass the build, then throw at request time.
  it('forbids event handlers in Server Components for web builds', () => {
    for (const t of ['web-fullstack', 'web-frontend']) {
      const p = buildBuildPhasePrompt(stateFor(t), phase);
      expect(p).toContain('No event handlers in Server Components');
      expect(p).toContain("'use client'");
    }
  });

  it('does not add the rule to non-web builds', () => {
    expect(buildBuildPhasePrompt(stateFor('cli'), phase)).not.toContain('No event handlers in Server Components');
  });
});
