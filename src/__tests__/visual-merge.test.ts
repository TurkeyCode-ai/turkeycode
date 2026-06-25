import { describe, it, expect } from 'vitest';
import { mergeVisualIntoVerdict } from '../orchestrator';

/**
 * Visual QA is a dedicated parallel session that writes its findings to
 * visual-N.json. The verdict (verdict-N.json) is the single source of truth the
 * gate, blocker-count, warnings-only, and fix-prompt logic all read — so visual
 * findings only gate the phase if they're folded into it. mergeVisualIntoVerdict
 * is that fold; these tests pin its rules.
 */
describe('mergeVisualIntoVerdict', () => {
  it('flips a CLEAN verdict to NEEDS_FIX when visual adds a blocker', () => {
    const verdict = { verdict: 'CLEAN', blockers: [], warnings: [] };
    const visual = {
      blockers: [{ description: 'gray text on white', location: 'home/desktop' }],
      warnings: []
    };
    const merged = mergeVisualIntoVerdict(verdict, visual);
    expect(merged.verdict).toBe('NEEDS_FIX');
    expect((merged.blockers as unknown[]).length).toBe(1);
  });

  it('normalizes visual findings to type "visual" with defaults', () => {
    const verdict = { verdict: 'CLEAN', blockers: [], warnings: [] };
    const visual = { blockers: [{ description: 'broken layout' }], warnings: [{}] };
    const merged = mergeVisualIntoVerdict(verdict, visual);
    const blocker = (merged.blockers as Array<Record<string, string>>)[0];
    expect(blocker.type).toBe('visual');
    expect(blocker.location).toBe('unknown');
    expect(blocker.severity).toBe('critical');
    const warning = (merged.warnings as Array<Record<string, string>>)[0];
    expect(warning.type).toBe('visual');
    expect(warning.description).toBe('visual warning');
  });

  it('appends to existing functional findings rather than replacing them', () => {
    const verdict = {
      verdict: 'NEEDS_FIX',
      blockers: [{ type: 'functional', description: 'save button 500s', location: 'api' }],
      warnings: [{ type: 'functional', description: 'slow load', location: 'home' }]
    };
    const visual = {
      blockers: [{ description: 'purple gradient hero', location: 'home/desktop' }],
      warnings: []
    };
    const merged = mergeVisualIntoVerdict(verdict, visual);
    expect((merged.blockers as unknown[]).length).toBe(2);
    expect((merged.blockers as Array<Record<string, string>>).map((b) => b.type)).toEqual([
      'functional',
      'visual'
    ]);
    expect((merged.warnings as unknown[]).length).toBe(1);
  });

  it('keeps the verdict CLEAN when visual contributes only warnings', () => {
    const verdict = { verdict: 'CLEAN', blockers: [], warnings: [] };
    const visual = { blockers: [], warnings: [{ description: 'minor misalignment' }] };
    const merged = mergeVisualIntoVerdict(verdict, visual);
    expect(merged.verdict).toBe('CLEAN');
    expect((merged.blockers as unknown[]).length).toBe(0);
    expect((merged.warnings as unknown[]).length).toBe(1);
  });

  it('records a visual summary block when the verdict has a summary', () => {
    const verdict = {
      verdict: 'CLEAN',
      blockers: [],
      warnings: [],
      summary: { smoke: { passed: true } }
    };
    const visual = { blockers: [{ description: 'x' }], warnings: [{ description: 'y' }] };
    const merged = mergeVisualIntoVerdict(verdict, visual);
    const summary = merged.summary as Record<string, Record<string, unknown>>;
    expect(summary.visual).toEqual({ passed: false, blockers: 1, warnings: 1 });
    expect(summary.smoke).toEqual({ passed: true }); // untouched
  });

  it('does not mutate the input verdict', () => {
    const verdict = { verdict: 'CLEAN', blockers: [], warnings: [] };
    mergeVisualIntoVerdict(verdict, { blockers: [{ description: 'x' }], warnings: [] });
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.blockers.length).toBe(0);
  });

  it('tolerates missing blockers/warnings arrays on both sides', () => {
    const merged = mergeVisualIntoVerdict({ verdict: 'CLEAN' }, {});
    expect(merged.verdict).toBe('CLEAN');
    expect((merged.blockers as unknown[]).length).toBe(0);
    expect((merged.warnings as unknown[]).length).toBe(0);
  });
});
