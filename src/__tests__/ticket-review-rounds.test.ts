import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Scripted review/fix sessions: each review call pops the next findings payload.
const reviewOutputs: string[] = [];
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
      }
      writeFileSync(opts.doneFile, 'done');
      return { exitCode: 0 };
    },
  }),
}));

import { createTicketOrchestrator } from '../ticket-orchestrator';

const cited = (summary: string) => JSON.stringify({ findings: [{ severity: 'bug', summary, evidence: ['a.ts:1'] }], verified: [] });
const clean = JSON.stringify({ findings: [], verified: [{ claim: 'checked', evidence: ['a.ts:2'] }] });

let dir: string;
const ticket = { key: 'PROJ-1', summary: 's', description: '', status: 'x', issueType: 'Story', labels: [], attachments: [], comments: [] };
const manifest = { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: '/r/api', base: 'develop' }], references: [], transitionAfterPush: 'In Review' };

async function runRounds(rounds: number) {
  const orch = createTicketOrchestrator({ manifestPath: join(dir, 'none.yaml'), reviewRounds: rounds, deep: true });
  const timings: Record<string, number> = {};
  return (orch as any).runReviewRounds(
    ticket, dir, manifest, manifest.repos, new Map([['/r/api', 'abc']]), 'ticket/PROJ-1', undefined, timings,
  );
}

describe('runReviewRounds', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turkeycode-review-'));
    reviewOutputs.length = 0;
    sessions.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a clean round 1 still runs round 2 with the other lens', async () => {
    reviewOutputs.push(clean, clean);
    expect(await runRounds(2)).toEqual([]);
    expect(sessions.map((s) => s.name)).toEqual(['review-1-PROJ-1', 'review-2-PROJ-1']);
    expect(sessions[0].prompt).toContain('Lens: ticket + reference fidelity');
    expect(sessions[1].prompt).toContain('Lens: integration');
  });

  it('fixes between rounds when round 1 finds something', async () => {
    reviewOutputs.push(cited('bug one'), clean);
    expect(await runRounds(2)).toEqual([]);
    expect(sessions.map((s) => s.name)).toEqual(['review-1-PROJ-1', 'fix-1-PROJ-1', 'review-2-PROJ-1']);
  });

  it('a last-round finding gets one extra fix → verify round instead of being left open', async () => {
    reviewOutputs.push(clean, cited('fix broke X'), clean);
    expect(await runRounds(2)).toEqual([]);
    expect(sessions.map((s) => s.name)).toEqual(['review-1-PROJ-1', 'review-2-PROJ-1', 'fix-2-PROJ-1', 'review-3-PROJ-1']);
  });

  it('findings after the extra round are reported open (no second extension)', async () => {
    reviewOutputs.push(clean, cited('a'), cited('still a'));
    const open = await runRounds(2);
    expect(open.map((f: { summary: string }) => f.summary)).toEqual(['still a']);
    expect(sessions.map((s) => s.name)).toEqual(['review-1-PROJ-1', 'review-2-PROJ-1', 'fix-2-PROJ-1', 'review-3-PROJ-1']);
  });

  it('re-runs a round once when nothing cited survives, then accepts a cited result', async () => {
    reviewOutputs.push('{"findings": [{"summary": "uncited"}]}', cited('real'));
    const open = await runRounds(1);
    expect(open.map((f: { summary: string }) => f.summary)).toEqual(['real']);
    expect(sessions.map((s) => s.name)).toEqual(['review-1-PROJ-1', 'review-1-retry-PROJ-1']);
    expect(sessions[1].prompt).toMatch(/discarded as "not reviewed"/);
  });

  it('fails the run when the retry is still not reviewed', async () => {
    reviewOutputs.push('{"findings": []}', '{"findings": []}');
    await expect(runRounds(1)).rejects.toThrow(/not reviewed/);
  });
});
