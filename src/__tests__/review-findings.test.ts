import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseReviewFindings, readReviewFindings, reviewAction } from '../review-findings';
import { buildCodeReviewPrompt } from '../prompts/code-review';
import { buildReviewFixPrompt } from '../prompts/review-fix';
import { buildPolishPrompt } from '../prompts/polish';
import { stageOfSession } from '../audit';
import { getDefaultState } from '../state';

function stateWithPhase() {
  const state = getDefaultState();
  state.buildPhases = [{
    number: 2,
    name: 'Checkout',
    status: 'qa',
    scope: 'checkout flow',
    deliverables: ['Cart page', 'Payment form'],
    acceptanceCriteria: [],
    buildAttempts: 1,
    qaAttempts: 1,
  } as any];
  return state;
}

describe('parseReviewFindings', () => {
  it('reads verdict, critical findings and warnings', () => {
    const f = parseReviewFindings(JSON.stringify({
      verdict: 'REQUEST_CHANGES',
      critical: [{ file: 'src/pay.ts:40', issue: 'charges twice on retry', impact: 'double billing', suggestion: 'idempotency key' }],
      warnings: [{ file: 'src/cart.ts:9', issue: 'unused import' }],
    }));
    expect(f).toEqual({
      verdict: 'REQUEST_CHANGES',
      critical: [{ file: 'src/pay.ts:40', issue: 'charges twice on retry', impact: 'double billing', suggestion: 'idempotency key' }],
      warnings: [{ file: 'src/cart.ts:9', issue: 'unused import', impact: undefined, suggestion: undefined }],
    });
  });

  it('drops entries with no issue text and tolerates missing or wrong-typed fields', () => {
    const f = parseReviewFindings(JSON.stringify({
      critical: [{ file: 'a.ts' }, 'a string', null, { issue: '   ' }, { issue: 'real', file: 7 }],
      warnings: 'none',
    }));
    expect(f).toEqual({
      verdict: '',
      critical: [{ file: '', issue: 'real', impact: undefined, suggestion: undefined }],
      warnings: [],
    });
  });

  it('is null for anything that is not a JSON object', () => {
    expect(parseReviewFindings('{not json')).toBeNull();
    expect(parseReviewFindings('[]')).toBeNull();
    expect(parseReviewFindings('"APPROVE"')).toBeNull();
  });
});

describe('readReviewFindings', () => {
  it('a missing file is "not recorded", not "found nothing"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-review-'));
    expect(readReviewFindings(join(dir, 'phase-1.json'))).toBeNull();
    writeFileSync(join(dir, 'phase-1.json'), JSON.stringify({ verdict: 'APPROVE', critical: [], warnings: [] }));
    expect(readReviewFindings(join(dir, 'phase-1.json'))).toEqual({ verdict: 'APPROVE', critical: [], warnings: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reviewAction', () => {
  const none = { verdict: 'APPROVE', critical: [], warnings: [{ file: '', issue: 'w' }] };
  const critical = { verdict: 'REQUEST_CHANGES', critical: [{ file: 'a.ts', issue: 'bug' }], warnings: [] };

  it('does nothing without critical findings, whatever the verdict says', () => {
    expect(reviewAction(none, false)).toBe('none');
    expect(reviewAction({ ...none, verdict: 'REQUEST_CHANGES' }, false)).toBe('none');
    expect(reviewAction(null, false)).toBe('none');
  });

  it('sends critical findings to a fix once per phase, never twice', () => {
    expect(reviewAction(critical, false)).toBe('fix');
    expect(reviewAction(critical, true)).toBe('already-attempted');
  });
});

describe('prompts', () => {
  it('the review prompt asks for the findings file and says what critical means', () => {
    const prompt = buildCodeReviewPrompt(stateWithPhase(), 2);
    expect(prompt).toContain('.turkey/reviews/phase-2.md');
    expect(prompt).toContain('.turkey/reviews/phase-2.json');
    expect(prompt).toContain('"critical"');
    expect(prompt).toContain('"warnings"');
    expect(prompt).toContain('What counts as Critical');
    expect(prompt).toContain('If you are not sure the defect is real, it is a Warning.');
  });

  it('the review-fix prompt carries only the critical findings and keeps the fix narrow', () => {
    const prompt = buildReviewFixPrompt(stateWithPhase(), 2, [
      { file: 'src/pay.ts:40', issue: 'charges twice on retry', impact: 'double billing', suggestion: 'idempotency key' },
      { file: '', issue: 'token logged in plain text' },
    ]);
    expect(prompt).toContain('Phase 2: Checkout');
    expect(prompt).toContain('### 1. src/pay.ts:40');
    expect(prompt).toContain('Issue: charges twice on retry');
    expect(prompt).toContain('Impact: double billing');
    expect(prompt).toContain("Reviewer's suggestion: idempotency key");
    expect(prompt).toContain('### 2. (no file given)');
    expect(prompt).toContain('A reviewer can be wrong');
    expect(prompt).toContain('Do not act on the review\'s warnings or suggestions');
    expect(prompt).toContain('.turkey/reviews/phase-2-fix.done');
  });

  it('the polish prompt points at the review warnings', () => {
    const prompt = buildPolishPrompt(stateWithPhase(), 1);
    expect(prompt).toContain('.turkey/reviews/');
    expect(prompt).toContain('`warnings` array');
  });

  it('a review-fix session is counted as fix time, not review time', () => {
    expect(stageOfSession('review-fix-2')).toBe('fix');
    expect(stageOfSession('code-review-2')).toBe('review');
  });
});
