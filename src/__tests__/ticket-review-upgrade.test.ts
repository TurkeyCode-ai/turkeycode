import { describe, it, expect } from 'vitest';
import { buildTicketReviewPrompt, reviewLens } from '../prompts/ticket-review';
import { buildTicketPlanPrompt } from '../prompts/ticket-plan';
import { buildTicketBuildPrompt } from '../prompts/ticket-build';
import { buildTicketFixPrompt } from '../prompts/ticket-fix';
import { buildMergeFixPrompt } from '../prompts/merge-fix';
import { parseReviewResult, planFinalizeStep, isCitation } from '../ticket-orchestrator';
import { RepoManifest, DEFAULT_REVIEW_CHECKLIST } from '../repos';
import { TicketDetail } from '../jira';

const ticket = {
  key: 'PROJ-7',
  summary: 'Send returned units to the legacy side',
  description: 'desc',
  status: 'To Do',
  issueType: 'Story',
  labels: [],
  attachments: [],
  comments: [],
} as unknown as TicketDetail;

const manifest: RepoManifest = {
  defaultBase: 'develop',
  branchPattern: 'ticket/{key}',
  repos: [{ path: '/r/api', base: 'develop' }],
  references: [{ path: '/legacy/src', role: 'legacy code being ported' }],
  related: [{ path: '/r/bridge', role: 'bridge producer/consumer' }],
  review: { checklist: ['Status codes: blank means active.'], replaceDefaultChecklist: false },
  transitionAfterPush: 'In Review',
};

const reviewInput = {
  ticket,
  manifest,
  repos: [{ path: '/r/api', baseSha: 'abc123' }],
  branchName: 'ticket/PROJ-7',
  planPath: '/t/plan.md',
  findingsPath: '/t/review-1.json',
  doneFile: '/t/review-1.done',
};

describe('ticket review prompt', () => {
  it('renders the related-repos block and the boundary instruction', () => {
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toContain('RELATED REPOS — live code this change must stay compatible with; read-only');
    expect(out).toContain('/r/bridge — bridge producer/consumer');
    expect(out).toMatch(/crosses a boundary \(bridge, API, queue, shared table\), open the other side and check the contract both ways/);
  });

  it('renders the default + manifest checklist under the known-failure-modes heading', () => {
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toContain('KNOWN FAILURE MODES — check each explicitly and state which apply');
    expect(out).toContain(`${DEFAULT_REVIEW_CHECKLIST.length + 1}. Status codes: blank means active.`);
    expect(out).toContain('1. Sentinel / literal values');
  });

  it('omits the checklist block when the manifest replaces the default with nothing', () => {
    const out = buildTicketReviewPrompt({
      ...reviewInput,
      manifest: { ...manifest, review: { checklist: [], replaceDefaultChecklist: true } },
    });
    expect(out).not.toContain('KNOWN FAILURE MODES');
  });

  it('asks the premise question', () => {
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toMatch(/Check the ticket's premise against the references/);
    expect(out).toMatch(/is a `bug` finding, not a pass/);
  });

  it('frames the plan as intent to be challenged and never as evidence', () => {
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toContain("BUILDER'S INTENT — to be challenged");
    expect(out).toMatch(/never cite the plan as evidence/);
    expect(out).not.toMatch(/build\.done/);
  });

  it('requires evidence on findings and a verified array', () => {
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toContain('"evidence"');
    expect(out).toContain('"verified"');
    expect(out).toMatch(/Uncited findings and uncited verified claims are discarded/);
  });

  it('uses different lenses for round 1 and round 2', () => {
    const r1 = buildTicketReviewPrompt({ ...reviewInput, round: 1, totalRounds: 2 });
    const r2 = buildTicketReviewPrompt({ ...reviewInput, round: 2, totalRounds: 2 });
    expect(r1).toContain('Lens: ticket + reference fidelity');
    expect(r1).not.toContain('Lens: integration');
    expect(r2).toContain('Lens: integration, re-entry, concurrency, bypass paths');
    expect(r2).not.toContain('Lens: ticket + reference fidelity');
    expect(r2).toContain('round 2 of 2');
  });

  it('gives a single-round review both lenses', () => {
    expect(reviewLens(1, 1)).toBe('combined');
    expect(reviewLens(3, 4)).toBe('fidelity');
    expect(reviewLens(4, 4)).toBe('integration');
    const out = buildTicketReviewPrompt(reviewInput);
    expect(out).toContain('Lens: ticket + reference fidelity');
    expect(out).toContain('Lens: integration');
  });

  it('adds the not-reviewed reminder on a retry', () => {
    expect(buildTicketReviewPrompt(reviewInput)).not.toMatch(/discarded as "not reviewed"/);
    expect(buildTicketReviewPrompt({ ...reviewInput, uncitedRetry: true })).toMatch(/discarded as "not reviewed"/);
  });
});

describe('related repos + premise in plan/build/fix prompts', () => {
  it('plan prompt has the related block and the premise check', () => {
    const out = buildTicketPlanPrompt({ ticket, manifest, imagePaths: [], planPath: '/t/plan.md', doneFile: '/t/plan.done' });
    expect(out).toContain('RELATED REPOS — live code this change must stay compatible with; read-only');
    expect(out).toMatch(/Premise check — the ticket may be wrong/);
    expect(out).toMatch(/Check the ticket's premise against the references/);
  });

  it('build prompt has the related block and forbids writing to it', () => {
    const out = buildTicketBuildPrompt({ ticket, manifest, branchName: 'b', imagePaths: [], doneFile: '/t/build.done' });
    expect(out).toContain('RELATED REPOS — live code');
    expect(out).toMatch(/Do NOT modify or commit anything inside the "RELATED REPOS" paths/);
  });

  it('omits the related block when none are configured', () => {
    const bare = { ...manifest, related: undefined };
    expect(buildTicketPlanPrompt({ ticket, manifest: bare, imagePaths: [], planPath: 'p', doneFile: 'd' })).not.toContain('RELATED REPOS');
    expect(buildTicketBuildPrompt({ ticket, manifest: bare, branchName: 'b', imagePaths: [], doneFile: 'd' })).not.toContain('RELATED REPOS');
    expect(buildTicketReviewPrompt({ ...reviewInput, manifest: bare })).not.toContain('RELATED REPOS');
  });

  it('fix prompt carries the related block', () => {
    const out = buildTicketFixPrompt({ ticket, manifest, branchName: 'b', findingsPath: 'f', doneFile: 'd' });
    expect(out).toContain('RELATED REPOS');
  });
});

describe('parseReviewResult (evidence rule)', () => {
  it('keeps cited findings and drops uncited ones', () => {
    const r = parseReviewResult(JSON.stringify({
      findings: [
        { severity: 'bug', summary: 'zero totals on the other side', evidence: ['/r/bridge/src/Writer.java:88'] },
        { severity: 'bug', summary: 'hunch', evidence: [] },
        { severity: 'should-fix', summary: 'no evidence key' },
        { severity: 'bug', summary: 'bad cite', evidence: ['somewhere in the writer'] },
      ],
      verified: [],
    }));
    expect(r.findings.map((f) => f.summary)).toEqual(['zero totals on the other side']);
    expect(r.droppedFindings).toBe(3);
    expect(r.reviewed).toBe(true);
  });

  it('keeps only cited verified claims and counts the rest', () => {
    const r = parseReviewResult(JSON.stringify({
      findings: [],
      verified: [
        { claim: 'rounding matches legacy', evidence: ['/legacy/src/calc.src:120-134', 'src/Calc.kt:42'] },
        { claim: 'looked fine', evidence: [] },
        { claim: '', evidence: ['a.kt:1'] },
        'not an object',
      ],
    }));
    expect(r.verified).toEqual([
      { claim: 'rounding matches legacy', evidence: ['/legacy/src/calc.src:120-134', 'src/Calc.kt:42'] },
    ]);
    expect(r.droppedVerified).toBe(3);
    expect(r.reviewed).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('treats zero findings and zero verified as not reviewed (not clean)', () => {
    expect(parseReviewResult('{"findings": []}').reviewed).toBe(false);
    const allUncited = parseReviewResult('{"findings": [{"summary": "x"}], "verified": [{"claim": "y"}]}');
    expect(allUncited.reviewed).toBe(false);
    expect(allUncited.droppedFindings).toBe(1);
    expect(allUncited.droppedVerified).toBe(1);
  });

  it('recognises file:line and file:start-end citations', () => {
    expect(isCitation('src/a.ts:12')).toBe(true);
    expect(isCitation('/abs/path/File.java:10-20')).toBe(true);
    expect(isCitation('src/a.ts:12 (guard removed)')).toBe(true);
    expect(isCitation('src/a.ts')).toBe(false);
    expect(isCitation(':12')).toBe(false);
    expect(isCitation(12)).toBe(false);
  });
});

describe('planFinalizeStep (--base-local / --no-push)', () => {
  const repo = { path: '/r/api', base: 'develop' };

  it('default: rebase onto origin/<base> and push', () => {
    expect(planFinalizeStep(repo, { noPush: false })).toEqual({ rebaseOnto: 'origin/develop', localRef: undefined, push: true });
  });

  it('--base-local: rebase onto the local ref (no fetch) and still push', () => {
    expect(planFinalizeStep(repo, { localRef: 'stack/week', noPush: false })).toEqual({
      rebaseOnto: 'stack/week', localRef: 'stack/week', push: true,
    });
  });

  it('--no-push: rebase but leave the branch local', () => {
    expect(planFinalizeStep(repo, { noPush: true }).push).toBe(false);
    expect(planFinalizeStep(repo, { localRef: 'stack', noPush: true })).toEqual({ rebaseOnto: 'stack', localRef: 'stack', push: false });
  });

  it('merge-fix prompt names the local rebase target instead of origin/<base>', () => {
    const out = buildMergeFixPrompt({
      repoPath: '/r/api', branchName: 'ticket/T', baseBranch: 'develop', conflictedPaths: ['a.ts'], doneFile: 'd', rebaseOnto: 'stack',
    });
    expect(out).toContain('rebased cleanly onto stack');
    expect(out).not.toContain('origin/develop');
  });
});

describe('--base-local awareness in review and fix prompts', () => {
  it('tells the reviewer the local base is intentional and not to flag stacking', () => {
    const out = buildTicketReviewPrompt({ ...reviewInput, repos: [{ path: '/r/api', baseSha: 'abc123', localBase: 'week-stack' }] });
    expect(out).toContain('Intended base');
    expect(out).toContain('`week-stack`');
    expect(out).toContain('never ask for a rebase');
  });

  it('says nothing about a local base on a normal run', () => {
    expect(buildTicketReviewPrompt(reviewInput)).not.toContain('Intended base');
  });

  it('marks local-based repos in the fix prompt and forbids rebasing', () => {
    const out = buildTicketFixPrompt({ ticket, manifest, branchName: 'b', findingsPath: 'f', doneFile: 'd', localBases: { [manifest.repos[0].path]: 'week-stack' } });
    expect(out).toContain('built on the local ref `week-stack` on purpose');
    expect(out).toContain('Do NOT rebase');
  });
});

describe('later rounds challenge the previous fixes', () => {
  it('asks the reviewer to challenge, not just verify, the prior round\'s fixes', () => {
    const out = buildTicketReviewPrompt({ ...reviewInput, priorFindingsPath: '/t/review-1.json', round: 2, totalRounds: 2 });
    expect(out).toContain('then challenge them');
  });
});

describe('local base reaches plan and build', () => {
  it('build prompt names the local base and forbids resetting to the default base', () => {
    const out = buildTicketBuildPrompt({ ticket, manifest, branchName: 'b', imagePaths: [], doneFile: 'd', localBases: { '/r/api': 'week-stack' } });
    expect(out).toContain('BRANCH BASE (this run)');
    expect(out).toContain('`week-stack`');
    expect(out).toContain('Do NOT reset, rebase or check out the default base');
  });
  it('plan prompt names the local base', () => {
    const out = buildTicketPlanPrompt({ ticket, manifest, imagePaths: [], planPath: 'p', doneFile: 'd', localBases: { '/r/api': 'week-stack' } });
    expect(out).toContain('`week-stack`');
  });
  it('no block on a normal run', () => {
    expect(buildTicketBuildPrompt({ ticket, manifest, branchName: 'b', imagePaths: [], doneFile: 'd' })).not.toContain('BRANCH BASE');
  });
});
