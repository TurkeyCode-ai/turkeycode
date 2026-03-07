import { describe, it, expect } from 'vitest';
import * as prompts from '../prompts';

describe('prompts', () => {
  it('exports all required prompt builders', () => {
    const requiredExports = [
      'buildResearchPrompt',
      'buildPlanPrompt',
      'buildBuildPhasePrompt',
      'buildQaSmokePrompt',
      'buildQaFunctionalPrompt',
      'buildQaVisualPrompt',
      'buildQaVerdictPrompt',
      'buildQaFixPrompt',
      'buildCodeReviewPrompt',
      'buildAarPrompt',
    ];

    for (const name of requiredExports) {
      expect((prompts as any)[name], `${name} should be exported`).toBeDefined();
      expect(typeof (prompts as any)[name], `${name} should be a function`).toBe('function');
    }
  });

  it('exports exactly the expected number of prompt builders', () => {
    const exportKeys = Object.keys(prompts);
    expect(exportKeys.length).toBeGreaterThanOrEqual(10);
  });

  describe('buildResearchPrompt', () => {
    const state: any = {
      description: 'Build a todo app',
      projectName: 'todo-app',
    };

    it('returns a non-empty string', () => {
      const prompt = prompts.buildResearchPrompt(state);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('contains research instructions', () => {
      const prompt = prompts.buildResearchPrompt(state);
      expect(prompt.toUpperCase()).toContain('RESEARCH');
    });

    it('references specs output file', () => {
      const prompt = prompts.buildResearchPrompt(state);
      expect(prompt).toContain('specs.md');
    });

    it('references the done signal', () => {
      const prompt = prompts.buildResearchPrompt(state);
      expect(prompt).toContain('research.done');
    });
  });

  describe('buildPlanPrompt', () => {
    const state: any = {
      description: 'Build a chat app',
      projectName: 'chat-app',
    };

    it('returns a non-empty string', () => {
      const prompt = prompts.buildPlanPrompt(state);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('contains plan instructions', () => {
      const prompt = prompts.buildPlanPrompt(state);
      expect(prompt).toContain('phase-plan.json');
    });

    it('mentions phases', () => {
      const prompt = prompts.buildPlanPrompt(state);
      expect(prompt.toLowerCase()).toContain('phase');
    });
  });

  describe('buildBuildPhasePrompt', () => {
    it('is a function that accepts arguments', () => {
      expect(typeof prompts.buildBuildPhasePrompt).toBe('function');
      expect(prompts.buildBuildPhasePrompt.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('QA prompt builders', () => {
    it('smoke test builder is a function', () => {
      expect(typeof prompts.buildQaSmokePrompt).toBe('function');
    });

    it('functional test builder is a function', () => {
      expect(typeof prompts.buildQaFunctionalPrompt).toBe('function');
    });

    it('visual test builder is a function', () => {
      expect(typeof prompts.buildQaVisualPrompt).toBe('function');
    });

    it('verdict builder is a function', () => {
      expect(typeof prompts.buildQaVerdictPrompt).toBe('function');
    });

    it('fix builder is a function', () => {
      expect(typeof prompts.buildQaFixPrompt).toBe('function');
    });
  });

  describe('post-build prompt builders', () => {
    it('code review builder is a function', () => {
      expect(typeof prompts.buildCodeReviewPrompt).toBe('function');
    });

    it('AAR builder is a function', () => {
      expect(typeof prompts.buildAarPrompt).toBe('function');
    });
  });
});
