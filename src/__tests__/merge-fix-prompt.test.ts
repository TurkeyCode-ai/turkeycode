import { describe, it, expect } from 'vitest';
import { buildMergeFixPrompt } from '../prompts/merge-fix';

/**
 * buildMergeFixPrompt drives two flows: the ticket flow's rebase-onto-origin
 * (default mode) and the phase flow's local merge. The "continue" / "abort" /
 * in-progress wording must match the actual git state the agent is in, or it
 * will run the wrong command and wedge the repo.
 */
describe('buildMergeFixPrompt', () => {
  const base = {
    repoPath: '/repo',
    branchName: 'phase-2/api',
    baseBranch: 'main',
    conflictedPaths: ['src/a.ts', 'src/b.ts'],
    doneFile: '/repo/.turkey/qa/phase-2/merge-fix-1.done',
  };

  it('rebase mode (default) uses rebase verbs and origin/<base>', () => {
    const p = buildMergeFixPrompt({ ...base, contextKey: 'PROJ-1' });
    expect(p).toContain('REBASE CONFLICT RESOLUTION');
    expect(p).toContain('git rebase --continue');
    expect(p).toContain('git rebase --abort');
    expect(p).toContain('origin/main');
    expect(p).not.toContain('git merge --abort');
  });

  it('merge mode uses merge verbs and a plain base branch', () => {
    const p = buildMergeFixPrompt({ ...base, mode: 'merge', contextKey: 'phase-2' });
    expect(p).toContain('MERGE CONFLICT RESOLUTION');
    expect(p).toContain('git commit --no-edit');
    expect(p).toContain('git merge --abort');
    expect(p).not.toContain('git rebase --continue');
    // merge integrates into the base branch, not origin/<base>
    expect(p).toContain('into `main`');
  });

  it('lists every conflicted path as a work item', () => {
    const p = buildMergeFixPrompt({ ...base, mode: 'merge' });
    expect(p).toContain('src/a.ts');
    expect(p).toContain('src/b.ts');
  });

  it('always instructs writing the done file and an ABORTED path', () => {
    const p = buildMergeFixPrompt({ ...base, mode: 'merge' });
    expect(p).toContain(base.doneFile);
    expect(p).toContain('ABORTED:');
  });

  it('includes the context block only when context is provided', () => {
    const withCtx = buildMergeFixPrompt({ ...base, mode: 'merge', contextKey: 'phase-2', contextSummary: 'build the API' });
    expect(withCtx).toContain('phase-2');
    expect(withCtx).toContain('build the API');
    // no crash / no "undefined" leakage when context omitted
    const withoutCtx = buildMergeFixPrompt({ ...base, mode: 'merge' });
    expect(withoutCtx).not.toContain('undefined');
  });
});
