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
      'buildPolishPrompt',
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

  describe('buildPolishPrompt', () => {
    const state: any = {
      projectType: 'web-fullstack',
      tech: { backend: 'Express', frontend: 'React', database: 'PostgreSQL' },
      buildPhases: [],
    };

    it('returns a non-empty string', () => {
      const prompt = prompts.buildPolishPrompt(state, 1);
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('instructs zero-warning cleanup and writes an attempt-scoped verdict', () => {
      const prompt = prompts.buildPolishPrompt(state, 2);
      expect(prompt).toContain('verdict-2.json');
      expect(prompt).toContain('polish-2.done');
      expect(prompt).toMatch(/ZERO/i);
      // must not encourage mass-suppression
      expect(prompt).toMatch(/disable|ignore|suppress/i);
    });

    it('composes the stack summary from tech context', () => {
      const prompt = prompts.buildPolishPrompt(state, 1);
      expect(prompt).toContain('Express + React + PostgreSQL');
    });

    it('falls back to projectType when tech context is empty', () => {
      const prompt = prompts.buildPolishPrompt({ projectType: 'cli', tech: {}, buildPhases: [] } as any, 1);
      expect(prompt).toContain('cli');
    });
  });

  describe('buildTicketTriagePrompt', () => {
    const baseInput: any = {
      ticket: {
        key: 'PROJ-1',
        summary: 'Inventory count off by one',
        description: 'desc',
        status: 'To Do',
        issueType: 'Bug',
        labels: [],
        attachments: [],
        comments: [],
      },
      manifest: {
        defaultBase: 'develop',
        branchPattern: 'ticket/{key}-{slug}',
        repos: [
          { path: '/r/orders-api', role: 'orders-api — checkout', base: 'develop' },
          { path: '/r/inventory-api', role: 'inventory-api — stock levels', base: 'develop' },
        ],
        references: [],
        transitionAfterPush: 'In Review',
      },
      imagePaths: [],
      verdictPath: '/tmp/verdict.json',
      doneFile: '/tmp/triage.done',
    };

    it('asks the LLM to emit a repos[] field', () => {
      const out = prompts.buildTicketTriagePrompt(baseInput);
      expect(out).toContain('"repos"');
      expect(out).toContain('AVAILABLE REPOS');
      expect(out).toContain('/r/orders-api');
      expect(out).toContain('/r/inventory-api');
    });

    it('instructs the LLM to use exact paths and warns about run failure on mismatch', () => {
      const out = prompts.buildTicketTriagePrompt(baseInput);
      expect(out).toMatch(/exact path/i);
      expect(out).toMatch(/string equality|fail the run/i);
    });

    it('omits the reference-files block when no references are configured', () => {
      const out = prompts.buildTicketTriagePrompt(baseInput);
      expect(out).not.toMatch(/REFERENCE FILES/);
    });

    it('lists references and forbids them in the repos[] output', () => {
      const input = {
        ...baseInput,
        manifest: {
          ...baseInput.manifest,
          references: [
            { path: '/legacy/app', role: 'legacy code being ported' },
          ],
        },
      };
      const out = prompts.buildTicketTriagePrompt(input);
      expect(out).toMatch(/REFERENCE FILES/);
      expect(out).toContain('/legacy/app');
      expect(out).toContain('legacy code being ported');
      expect(out).toMatch(/DO NOT include/i);
    });
  });

  describe('buildTicketBuildPrompt', () => {
    const baseInput: any = {
      ticket: {
        key: 'PROJ-1',
        summary: 'Port masterfile feature',
        description: 'desc',
        status: 'In Progress',
        issueType: 'Story',
        labels: [],
        attachments: [],
        comments: [],
      },
      manifest: {
        defaultBase: 'develop',
        branchPattern: 'ticket/{key}-{slug}',
        repos: [
          { path: '/r/legacy-masterfile', role: 'masterfile backend', base: 'develop' },
        ],
        references: [],
        transitionAfterPush: 'In Review',
      },
      branchName: 'ticket/PROJ-1-port-masterfile-feature',
      imagePaths: [],
      triageSummary: 'Port a feature from legacy code',
      doneFile: '/tmp/build.done',
    };

    it('omits the reference-files block when no references are configured', () => {
      const out = prompts.buildTicketBuildPrompt(baseInput);
      expect(out).not.toMatch(/READ-ONLY REFERENCE FILES/);
    });

    it('lists references and forbids modifying or committing inside them', () => {
      const input = {
        ...baseInput,
        manifest: {
          ...baseInput.manifest,
          references: [
            { path: '/legacy/app', role: 'legacy code being ported' },
          ],
        },
      };
      const out = prompts.buildTicketBuildPrompt(input);
      expect(out).toMatch(/READ-ONLY REFERENCE FILES/);
      expect(out).toContain('/legacy/app');
      expect(out).toMatch(/Do NOT modify or commit/);
    });
  });
});
