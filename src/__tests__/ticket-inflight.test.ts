import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { clearInFlight, listInFlight, markInFlight } from '../ticket-inflight';
import { renderInFlightBlock } from '../prompts/ticket-common';
import { buildTicketPlanPrompt } from '../prompts/ticket-plan';
import { buildTicketBuildPrompt } from '../prompts/ticket-build';
import { buildMergeFixPrompt } from '../prompts/merge-fix';

let root: string;
const marker = (key: string) => join(root, key, 'in-flight.json');

/** A marker left by another process. `pid` decides whether that process counts as alive. */
function otherRun(key: string, pid: number, repos: string[]) {
  mkdirSync(join(root, key), { recursive: true });
  writeFileSync(marker(key), JSON.stringify({ pid, key, summary: `${key} summary`, branch: `ticket/${key}`, repos, startedAt: 'now' }));
}
/** A pid that has just exited, so nothing is running under it. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'turkeycode-inflight-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('in-flight ticket markers', () => {
  it('a run announces itself and removes its marker when it ends', () => {
    markInFlight(root, { key: 'PROJ-1', summary: 'one', branch: 'ticket/PROJ-1', repos: ['/r/api'] });
    const written = JSON.parse(readFileSync(marker('PROJ-1'), 'utf-8'));
    expect(written).toMatchObject({ pid: process.pid, key: 'PROJ-1', branch: 'ticket/PROJ-1', repos: ['/r/api'] });

    clearInFlight(root, 'PROJ-1');
    expect(existsSync(marker('PROJ-1'))).toBe(false);
    clearInFlight(root, 'PROJ-1'); // already gone: no throw
  });

  it('lists live runs in a shared repo, with the plan once it exists, and never itself', () => {
    markInFlight(root, { key: 'PROJ-1', summary: 'mine', branch: 'ticket/PROJ-1', repos: ['/r/api'] });
    otherRun('PROJ-2', process.pid, ['/r/api', '/r/web']);
    otherRun('PROJ-3', process.pid, ['/r/api']);
    writeFileSync(join(root, 'PROJ-3', 'plan.md'), '# plan');

    const others = listInFlight(root, 'PROJ-1', ['/r/api']);
    expect(others.map((o) => o.key)).toEqual(['PROJ-2', 'PROJ-3']);
    expect(others[0].planPath).toBeUndefined();
    expect(others[1].planPath).toBe(join(root, 'PROJ-3', 'plan.md'));
  });

  it('a run in unrelated repos is not a neighbour', () => {
    otherRun('PROJ-2', process.pid, ['/r/billing']);
    expect(listInFlight(root, 'PROJ-1', ['/r/api'])).toEqual([]);
    expect(existsSync(marker('PROJ-2'))).toBe(true);
  });

  it('a marker whose process is gone is skipped and cleaned up', () => {
    otherRun('PROJ-2', deadPid(), ['/r/api']);
    expect(listInFlight(root, 'PROJ-1', ['/r/api'])).toEqual([]);
    expect(existsSync(marker('PROJ-2'))).toBe(false);
  });

  it('a finished ticket folder and a corrupt marker are ignored', () => {
    mkdirSync(join(root, 'PROJ-2'));
    writeFileSync(join(root, 'PROJ-2', 'plan.md'), '# old plan');
    mkdirSync(join(root, 'PROJ-3'));
    writeFileSync(marker('PROJ-3'), '{not json');
    expect(listInFlight(root, 'PROJ-1', ['/r/api'])).toEqual([]);
    expect(listInFlight(join(root, 'missing'), 'PROJ-1', ['/r/api'])).toEqual([]);
  });

  it('ending a run does not remove a marker another live process owns', () => {
    // Same ticket, rerun in another terminal while this one is finishing. The parent test runner stands in for it.
    otherRun('PROJ-1', process.ppid, ['/r/api']);
    clearInFlight(root, 'PROJ-1');
    expect(existsSync(marker('PROJ-1'))).toBe(true);
  });
});

describe('prompts', () => {
  const ticket = { key: 'PROJ-1', summary: 's', description: '', status: 'x', issueType: 'Story', labels: [], attachments: [], comments: [] };
  const manifest = { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [{ path: '/r/api', base: 'develop' }], references: [], transitionAfterPush: 'In Review' };
  const neighbours = [
    { key: 'PROJ-2', summary: 'pricing floor', branch: 'ticket/PROJ-2', planPath: '/t/PROJ-2/plan.md' },
    { key: 'PROJ-3', summary: 'item totals', branch: 'ticket/PROJ-3' },
  ];

  it('says nothing when the ticket is alone', () => {
    expect(renderInFlightBlock([], 'plan')).toBe('');
    expect(renderInFlightBlock(undefined, 'build')).toBe('');
    const plan = buildTicketPlanPrompt({ ticket, manifest, imagePaths: [], planPath: '/t/plan.md', doneFile: '/t/plan.done' } as any);
    expect(plan).not.toContain('OTHER TICKETS BEING BUILT');
  });

  it('the plan session is pointed at the other plans and asked to record overlaps', () => {
    const plan = buildTicketPlanPrompt({ ticket, manifest, imagePaths: [], planPath: '/t/plan.md', doneFile: '/t/plan.done', inFlight: neighbours } as any);
    expect(plan).toContain('OTHER TICKETS BEING BUILT RIGHT NOW');
    expect(plan).toContain('**PROJ-2** (pricing floor) on branch `ticket/PROJ-2`: plan at `/t/PROJ-2/plan.md`');
    expect(plan).toContain('**PROJ-3** (item totals) on branch `ticket/PROJ-3`: no plan written yet');
    expect(plan).toContain('Overlap with in-flight tickets');
    expect(plan).toContain('a decision for a person');
  });

  it('the build session is told to keep shared edits small and not to pull the other work in', () => {
    const build = buildTicketBuildPrompt({ ticket, manifest, branchName: 'ticket/PROJ-1', imagePaths: [], doneFile: '/t/build.done', inFlight: neighbours } as any);
    expect(build).toContain('OTHER TICKETS BEING BUILT RIGHT NOW');
    expect(build).toContain('keep your edit small and local');
    expect(build).toContain('Their work is NOT on your branch');
    expect(build).not.toContain('Overlap with in-flight tickets');
  });

  it('merge-fix is told where another ticket\'s plan lives', () => {
    const base = { repoPath: '/r/api', branchName: 'ticket/PROJ-1', baseBranch: 'develop', conflictedPaths: ['a.ts'], doneFile: '/t/m.done' };
    expect(buildMergeFixPrompt({ ...base, ticketsRoot: '/home/u/.turkeycode/tickets' })).toContain('/home/u/.turkeycode/tickets/<KEY>/plan.md');
    expect(buildMergeFixPrompt(base)).not.toContain('<KEY>/plan.md');
  });
});
