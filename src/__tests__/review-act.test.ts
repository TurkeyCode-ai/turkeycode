/**
 * The step that acts on a code review, driven against a real git repository
 * with the agent session and the QA pass stubbed. What matters here is what
 * ends up on the branch: the fix when QA passes it, the QA-passed code when
 * QA does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../state', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, saveState: vi.fn() };
});
vi.mock('../audit', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, audit: vi.fn() };
});

import { Orchestrator } from '../orchestrator';
import { audit } from '../audit';
import { REVIEWS_DIR } from '../constants';

let dir: string;
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: 'pipe' }).toString().trim();

/** An orchestrator with only what actOnReview touches, no constructor side effects. */
function harness(opts: {
  fix: () => void;
  qaPasses?: boolean;
}) {
  const phase: any = { number: 1, name: 'P', deliverables: [], branchName: 'phase-1/p', status: 'review' };
  const o: any = Object.create(Orchestrator.prototype);
  o.workDir = dir;
  o.state = { buildPhases: [phase] };
  o.log = () => {};
  o.sessions = [] as string[];
  o.spawner = {
    run: async (s: any) => {
      o.sessions.push(s.sessionName);
      o.prompt = s.prompt;
      opts.fix();
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    },
  };
  o.pushes = 0;
  o.github = {
    hasUncommittedChanges: () => git('status --porcelain') !== '',
    commit: (msg: string) => { git('add -A'); git(`commit -q -m "${msg}"`); },
    push: () => { o.pushes++; },
  };
  o.qaRuns = 0;
  o.runQAFast = async (_n: number, exitOnFail: boolean) => {
    o.qaRuns++;
    expect(exitOnFail).toBe(false); // a failed re-QA must not stop the run
    return opts.qaPasses ?? true;
  };
  return { o, phase };
}

function writeFindings(findings: unknown) {
  mkdirSync(join(dir, REVIEWS_DIR), { recursive: true });
  writeFileSync(join(dir, REVIEWS_DIR, 'phase-1.json'), JSON.stringify(findings));
}

const CRITICAL = {
  verdict: 'REQUEST_CHANGES',
  critical: [{ file: 'app.txt:1', issue: 'wrong value', impact: 'users see the wrong value' }],
  warnings: [{ file: 'app.txt', issue: 'naming' }, { file: 'b', issue: 'other' }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-review-act-'));
  git('init -q');
  git('config user.email t@example.com');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), '.turkey/\n');
  writeFileSync(join(dir, 'app.txt'), 'qa-passed\n');
  git('add -A');
  git('commit -q -m "phase work"');
  vi.mocked(audit).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('acting on a code review', () => {
  it('an approving review runs nothing and records its warning count', async () => {
    writeFindings({ verdict: 'APPROVE', critical: [], warnings: [{ file: 'a', issue: 'w' }] });
    const { o, phase } = harness({ fix: () => { throw new Error('no session expected'); } });
    await o.actOnReview(1, phase);
    expect(o.sessions).toEqual([]);
    expect(o.qaRuns).toBe(0);
    expect(phase.reviewWarnings).toBe(1);
    expect(phase.reviewFixAttempted).toBeUndefined();
  });

  it('a review that wrote no findings file is "not recorded" and runs nothing', async () => {
    const { o, phase } = harness({ fix: () => { throw new Error('no session expected'); } });
    await o.actOnReview(1, phase);
    expect(o.sessions).toEqual([]);
    expect(phase.reviewWarnings).toBeUndefined();
  });

  it('critical findings: one fix session, then QA again, and the fix stays when QA passes', async () => {
    writeFindings(CRITICAL);
    const { o, phase } = harness({
      fix: () => writeFileSync(join(dir, 'app.txt'), 'fixed\n'),
      qaPasses: true,
    });
    await o.actOnReview(1, phase);
    expect(o.sessions).toEqual(['review-fix-1']);
    expect(o.prompt).toContain('wrong value');
    expect(o.prompt).not.toContain('naming'); // warnings are not sent to the fix
    expect(o.qaRuns).toBe(1);
    expect(readFileSync(join(dir, 'app.txt'), 'utf-8')).toBe('fixed\n');
    expect(git('status --porcelain')).toBe('');
    expect(git('log --oneline').split('\n')).toHaveLength(2);
    expect(phase.reviewFixAttempted).toBe(true);
    expect(phase.reviewWarnings).toBe(2);
    expect(o.pushes).toBe(1);
    expect(vi.mocked(audit).mock.calls.map((c) => c[0])).toEqual(['fix_started', 'fix_completed']);
  });

  it('when QA cannot pass the fix, the fix is discarded and the QA-passed code is what remains', async () => {
    writeFindings(CRITICAL);
    const qaPassed = git('rev-parse HEAD');
    const { o, phase } = harness({
      fix: () => writeFileSync(join(dir, 'app.txt'), 'broken by the fix\n'),
      qaPasses: false,
    });
    await o.actOnReview(1, phase);
    expect(o.qaRuns).toBe(1);
    expect(git('rev-parse HEAD')).toBe(qaPassed);
    expect(readFileSync(join(dir, 'app.txt'), 'utf-8')).toBe('qa-passed\n');
    expect(phase.lastQaVerdict).toBe('CLEAN');
    expect(o.pushes).toBe(2); // the fix, then the return to the QA-passed commit
    expect(vi.mocked(audit).mock.calls.map((c) => c[0])).toEqual(['fix_started', 'fix_reverted']);
  });

  it('a fix that changes no files skips the second QA pass, even if it made an empty commit', async () => {
    writeFindings(CRITICAL);
    const { o, phase } = harness({ fix: () => git('commit -q --allow-empty -m "review-fix: finding does not hold"') });
    await o.actOnReview(1, phase);
    expect(o.sessions).toEqual(['review-fix-1']);
    expect(o.qaRuns).toBe(0);
    expect(o.pushes).toBe(0);
    expect(vi.mocked(audit).mock.calls.map((c) => c[0])).toEqual(['fix_started', 'fix_noop']);
  });

  it('a phase that already had its review fix is not fixed again', async () => {
    writeFindings(CRITICAL);
    const { o, phase } = harness({ fix: () => { throw new Error('no session expected'); } });
    phase.reviewFixAttempted = true;
    await o.actOnReview(1, phase);
    expect(o.sessions).toEqual([]);
    expect(o.qaRuns).toBe(0);
  });
});
