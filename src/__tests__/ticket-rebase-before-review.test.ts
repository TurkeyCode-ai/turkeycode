import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

// The merge-fix session is scripted per test: it gets the repo path and the done file.
let mergeFix: (repoPath: string, doneFile: string) => void = () => {};
const sessions: { name: string; prompt: string }[] = [];

vi.mock('../jira', async (orig) => ({
  ...(await orig<typeof import('../jira')>()),
  isJiraConfigured: () => true,
  createJiraClient: () => ({}),
}));

vi.mock('../spawner', () => ({
  createSpawner: () => ({
    run: async (opts: { sessionName: string; prompt: string; doneFile: string; cwd: string }) => {
      sessions.push({ name: opts.sessionName, prompt: opts.prompt });
      mergeFix(opts.cwd, opts.doneFile);
      return { exitCode: 0 };
    },
  }),
}));

import { createTicketOrchestrator } from '../ticket-orchestrator';
import { rebaseInProgress } from '../repos';
import { buildMergeFixPrompt } from '../prompts/merge-fix';

let dir: string;
let repoPath: string;
const ticket = { key: 'PROJ-1', summary: 's', description: '', status: 'x', issueType: 'Story', labels: [], attachments: [], comments: [] };
const BRANCH = 'ticket/PROJ-1';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_EDITOR: 'true' };

const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repoPath, encoding: 'utf-8', env: ENV, stdio: 'pipe' }).trim();
function commit(file: string, content: string, message: string) {
  writeFileSync(join(repoPath, file), content);
  git(`add ${file}`);
  git(`commit -q -m "${message}"`);
}

/**
 * A repo where `stack` (the local base) moved after the ticket branch was cut.
 * `stackEdit` is what another ticket did on the stack; `ticketEdit` is this ticket's change.
 */
function makeRepo(stackEdit: [string, string], ticketEdit: [string, string]) {
  execSync(`git init -q -b stack "${repoPath}"`, { env: ENV });
  commit('service.txt', 'line one\n', 'base');
  const cutFrom = git('rev-parse HEAD');
  git(`checkout -q -b ${BRANCH}`);
  commit(ticketEdit[0], ticketEdit[1], 'PROJ-1: ticket change');
  git('checkout -q stack');
  commit(stackEdit[0], stackEdit[1], 'PROJ-2: another ticket landed');
  git(`checkout -q ${BRANCH}`);
  return cutFrom;
}

async function rebaseBeforeReview(baseShas: Map<string, string>) {
  const orch = createTicketOrchestrator({ manifestPath: join(dir, 'none.yaml'), deep: true }) as any;
  const repo = { path: repoPath, base: 'develop' };
  return orch.rebaseBeforeReview(
    ticket, [repo], BRANCH, dir, { summary: 'what the ticket does' }, new Map([[repoPath, 'stack']]), baseShas, join(dir, 'plan.md'),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turkeycode-rebase-'));
  repoPath = join(dir, 'repo');
  sessions.length = 0;
  mergeFix = () => {};
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('rebaseBeforeReview', () => {
  it('puts the branch on the moved base and moves the review base with it', async () => {
    const cutFrom = makeRepo(['other.txt', 'theirs\n'], ['mine.txt', 'ours\n']);
    const baseShas = new Map([[repoPath, cutFrom]]);
    await rebaseBeforeReview(baseShas);

    const stackTip = git('rev-parse stack');
    expect(sessions).toEqual([]);
    expect(git(`merge-base ${BRANCH} stack`)).toBe(stackTip);
    expect(baseShas.get(repoPath)).toBe(stackTip);
    // The review diff is still only this ticket's change.
    expect(git(`diff --name-only ${baseShas.get(repoPath)}..HEAD`)).toBe('mine.txt');
  });

  it('hands a conflict to merge-fix before review, with the plan and the base history to read', async () => {
    const cutFrom = makeRepo(['service.txt', 'line one\ntheirs\n'], ['service.txt', 'line one\nours\n']);
    mergeFix = (path, doneFile) => {
      writeFileSync(join(path, 'service.txt'), 'line one\ntheirs\nours\n');
      execSync('git add service.txt && git rebase --continue', { cwd: path, env: ENV, stdio: 'pipe' });
      writeFileSync(doneFile, 'OK: rebased cleanly onto stack\nResolved: service.txt');
    };
    const baseShas = new Map([[repoPath, cutFrom]]);
    await rebaseBeforeReview(baseShas);

    expect(sessions.map((s) => s.name)).toEqual(['merge-fix-PROJ-1']);
    expect(sessions[0].prompt).toContain(join(dir, 'plan.md'));
    expect(sessions[0].prompt).toContain('git log -p $(git merge-base ORIG_HEAD stack)..stack');
    expect(rebaseInProgress(repoPath)).toBe(false);
    expect(readFileSync(join(repoPath, 'service.txt'), 'utf-8')).toBe('line one\ntheirs\nours\n');
    expect(baseShas.get(repoPath)).toBe(git('rev-parse stack'));
  });

  it('a conflict nobody can resolve leaves the branch as built and does not throw', async () => {
    const cutFrom = makeRepo(['service.txt', 'line one\ntheirs\n'], ['service.txt', 'line one\nours\n']);
    const builtTip = git('rev-parse HEAD');
    mergeFix = (path, doneFile) => {
      execSync('git rebase --abort', { cwd: path, env: ENV, stdio: 'pipe' });
      writeFileSync(doneFile, 'ABORTED: the two tickets want opposite rules');
    };
    const baseShas = new Map([[repoPath, cutFrom]]);
    await rebaseBeforeReview(baseShas);

    expect(rebaseInProgress(repoPath)).toBe(false);
    expect(git('rev-parse HEAD')).toBe(builtTip);
    expect(git('rev-parse --abbrev-ref HEAD')).toBe(BRANCH);
    expect(git('status --porcelain')).toBe('');
    expect(baseShas.get(repoPath)).toBe(cutFrom);
  });

  it('a merge-fix session that dies mid-rebase does not leave the rebase in progress', async () => {
    const cutFrom = makeRepo(['service.txt', 'line one\ntheirs\n'], ['service.txt', 'line one\nours\n']);
    const builtTip = git('rev-parse HEAD');
    mergeFix = () => {}; // no done file, conflict untouched
    const baseShas = new Map([[repoPath, cutFrom]]);
    await rebaseBeforeReview(baseShas);

    expect(rebaseInProgress(repoPath)).toBe(false);
    expect(git('rev-parse HEAD')).toBe(builtTip);
    expect(baseShas.get(repoPath)).toBe(cutFrom);
  });
});

describe('merge-fix prompt', () => {
  const base = { repoPath: '/r/api', branchName: BRANCH, baseBranch: 'develop', conflictedPaths: ['a.ts'], doneFile: '/t/merge.done' };

  it('tells the session to read why the base changed, and not to abort just because it is hard', () => {
    const prompt = buildMergeFixPrompt(base);
    expect(prompt).toContain('git log -p $(git merge-base ORIG_HEAD origin/develop)..origin/develop -- <file>');
    expect(prompt).toContain('is not a reason to abort');
    expect(prompt).not.toContain('is written in');
  });

  it('merge mode reads the base history from the merge heads', () => {
    expect(buildMergeFixPrompt({ ...base, mode: 'merge' })).toContain('git log -p $(git merge-base HEAD MERGE_HEAD)..HEAD -- <file>');
  });
});
