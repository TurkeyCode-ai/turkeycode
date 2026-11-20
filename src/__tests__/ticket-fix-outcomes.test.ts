import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

// Scripted sessions: each review pops the next findings payload; each fix pops the next outcome.
const reviewOutputs: string[] = [];
const fixOutcomes: { exitCode: number; report?: string }[] = [];
const sessions: { name: string; prompt: string }[] = [];

vi.mock('../jira', async (orig) => ({
  ...(await orig<typeof import('../jira')>()),
  isJiraConfigured: () => true,
  createJiraClient: () => ({}),
}));

vi.mock('../spawner', () => ({
  createSpawner: () => ({
    run: async (opts: { sessionName: string; prompt: string; doneFile: string }) => {
      sessions.push({ name: opts.sessionName, prompt: opts.prompt });
      if (opts.sessionName.startsWith('review-')) {
        const m = opts.prompt.match(/write your findings to `([^`]+)`/);
        writeFileSync(m![1], reviewOutputs.shift() ?? '{"findings": []}');
        writeFileSync(opts.doneFile, 'done');
        return { exitCode: 0 };
      }
      const outcome = fixOutcomes.shift() ?? { exitCode: 0, report: 'fixed: it' };
      if (outcome.report !== undefined) writeFileSync(opts.doneFile, outcome.report);
      return { exitCode: outcome.exitCode };
    },
  }),
}));

import { createTicketOrchestrator, isNeedsHuman } from '../ticket-orchestrator';
import { buildTicketFixPrompt } from '../prompts/ticket-fix';
import { buildTicketReviewPrompt } from '../prompts/ticket-review';
import { stashUncommitted } from '../repos';

const finding = (severity: string, summary: string, line = 1) =>
  ({ severity, summary, file: 'a.ts', line, evidence: [`a.ts:${line}`] });
const review = (...findings: object[]) =>
  JSON.stringify({ findings, verified: [{ claim: 'checked', evidence: ['a.ts:9'] }] });

let dir: string;
const ticket = { key: 'PROJ-1', summary: 's', description: '', status: 'x', issueType: 'Story', labels: [], attachments: [], comments: [] };
const manifest = { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: '/r/api', base: 'develop' }], references: [], transitionAfterPush: 'In Review' };

function orchestrator(rounds: number) {
  return createTicketOrchestrator({ manifestPath: join(dir, 'none.yaml'), reviewRounds: rounds, deep: true }) as any;
}
function runRounds(orch: any) {
  return orch.runReviewRounds(ticket, dir, manifest, manifest.repos, new Map([['/r/api', 'abc']]), 'ticket/PROJ-1', undefined, {});
}
const names = () => sessions.map((s) => s.name);
const promptOf = (name: string) => sessions.find((s) => s.name === name)!.prompt;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turkeycode-fix-outcomes-'));
  reviewOutputs.length = 0;
  fixOutcomes.length = 0;
  sessions.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('a rejected finding reaches the next reviewer with its reason', () => {
  it('hands the fix session report to the following review round', async () => {
    reviewOutputs.push(review(finding('bug', 'close type not saved')), review());
    fixOutcomes.push({ exitCode: 0, report: 'rejected: close type not saved — needs a migration number only a person can assign' });
    expect(await runRounds(orchestrator(2))).toEqual([]);

    expect(promptOf('review-1-PROJ-1')).not.toContain('PREVIOUS ROUND');
    const second = promptOf('review-2-PROJ-1');
    expect(second).toContain(join(dir, 'review-1.json'));
    expect(second).toContain(join(dir, 'fix-1.done'));
    expect(second).toContain('declined on purpose');
    expect(second).toContain('needs-human');
  });

  it('a needs-human finding stays open but gets no fix session and no extra round', async () => {
    reviewOutputs.push(
      review(finding('bug', 'close type not saved')),
      review(finding('needs-human', 'close type not saved: assign a migration number')),
    );
    fixOutcomes.push({ exitCode: 0, report: 'rejected: close type not saved — needs a migration number' });
    const open = await runRounds(orchestrator(2));

    expect(names()).toEqual(['review-1-PROJ-1', 'fix-1-PROJ-1', 'review-2-PROJ-1']);
    expect(open).toHaveLength(1);
    expect(isNeedsHuman(open[0])).toBe(true);
  });

  it('fixable findings beside a needs-human one still get fixed, and it is reported once', async () => {
    reviewOutputs.push(
      review(finding('needs-human', 'pick a rounding rule', 4), finding('bug', 'off by one', 7)),
      review(finding('needs-human', 'pick a rounding rule (still undecided)', 4)),
    );
    const open = await runRounds(orchestrator(2));

    expect(names()).toEqual(['review-1-PROJ-1', 'fix-1-PROJ-1', 'review-2-PROJ-1']);
    expect(open.map((f: { severity: string }) => f.severity)).toEqual(['needs-human']);
  });
});

describe('a fix session that does not finish', () => {
  it('does not fail the ticket: the next round re-checks and the open findings are reported', async () => {
    reviewOutputs.push(review(finding('bug', 'regression')), review(finding('bug', 'regression')), review(finding('bug', 'regression')));
    fixOutcomes.push({ exitCode: 124 }, { exitCode: 0, report: 'fixed: regression' });
    const orch = orchestrator(2);
    const open = await runRounds(orch);

    expect(names()).toEqual(['review-1-PROJ-1', 'fix-1-PROJ-1', 'review-2-PROJ-1', 'fix-2-PROJ-1', 'review-3-PROJ-1']);
    expect(promptOf('review-2-PROJ-1')).toContain('did NOT finish');
    expect(promptOf('review-2-PROJ-1')).not.toContain('fix-1.done');
    expect(promptOf('review-3-PROJ-1')).not.toContain('did NOT finish');
    expect(open.map((f: { summary: string }) => f.summary)).toEqual(['regression']);
    expect(orch.reviewNotes).toHaveLength(1);
    expect(orch.reviewNotes[0]).toContain('round 1 ran out of time');
  });

  it('a crash is reported as a failure, not as a timeout', async () => {
    reviewOutputs.push(review(finding('bug', 'x')), review());
    fixOutcomes.push({ exitCode: 1 });
    const orch = orchestrator(2);
    expect(await runRounds(orch)).toEqual([]);
    expect(orch.reviewNotes[0]).toContain('failed (exit 1)');
  });
});

describe('stashUncommitted', () => {
  it('sets uncommitted work aside without discarding it, and reports a clean tree as nothing to do', () => {
    const repo = join(dir, 'repo');
    execSync(`git init -q "${repo}"`);
    const git = (cmd: string) => execSync(`git -c user.email=t@example.com -c user.name=t ${cmd}`, { cwd: repo, encoding: 'utf-8' });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add a.txt');
    git('commit -q -m base');
    expect(stashUncommitted(repo, 'nothing here')).toBe(false);

    writeFileSync(join(repo, 'a.txt'), 'half a fix\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    expect(stashUncommitted(repo, 'turkeycode PROJ-1 fix-1 unfinished')).toBe(true);
    expect(git('status --porcelain').trim()).toBe('');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(git('stash list')).toContain('turkeycode PROJ-1 fix-1 unfinished');
    git('stash pop -q');
    expect(existsSync(join(repo, 'new.txt'))).toBe(true);
  });

  it('returns false for a path that is not a repo', () => {
    expect(stashUncommitted(join(dir, 'missing'), 'x')).toBe(false);
  });
});

describe('prompts', () => {
  it('the fix session commits as it goes and leaves needs-human findings alone', () => {
    const prompt = buildTicketFixPrompt({ ticket, manifest, branchName: 'ticket/PROJ-1', findingsPath: '/t/review-1.json', doneFile: '/t/fix-1.done' } as any);
    expect(prompt).toContain('Commit each finished fix before starting the next');
    expect(prompt).toContain('needs-human');
  });

  it('a first-round review is told nothing about a previous round', () => {
    const prompt = buildTicketReviewPrompt({
      ticket, manifest, repos: [{ path: '/r/api', baseSha: 'abc' }], branchName: 'ticket/PROJ-1', findingsPath: '/t/review-1.json', doneFile: '/t/review-1.done',
    } as any);
    expect(prompt).not.toContain('PREVIOUS ROUND');
    expect(prompt).toContain('"bug" | "should-fix" | "needs-human"');
  });
});
