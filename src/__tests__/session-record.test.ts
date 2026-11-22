/**
 * Every session the spawner runs leaves one record in the audit log, with
 * its time and, when the backend reports them, its tokens and cost. These
 * run a real child process standing in for the agent CLI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(__dirname, '../../.test-session-record');

vi.mock('../constants', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    AUDIT_LOG: join(__dirname, '../../.test-session-record/.turkey/audit.log'),
  };
});

import { Spawner } from '../spawner';
import { CLAUDE_BACKEND, AgentBackendSpec } from '../agents';
import { setAuditBuildPhase, stageOfSession } from '../audit';
import { setAsideQaArtifacts } from '../orchestrator';

const LOG = join(TEST_DIR, '.turkey/audit.log');

/** A backend whose "CLI" is a shell script printing the given stdout. */
function fakeBackend(script: string, reportsUsage: boolean): AgentBackendSpec {
  return {
    ...CLAUDE_BACKEND,
    id: 'fake',
    binary: '/bin/sh',
    baseArgs: ['-c', script],
    usageArgs: reportsUsage ? ['--output-format', 'stream-json'] : undefined,
    outputFormat: reportsUsage ? 'claude-stream-json' : undefined,
  };
}

function records(): any[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.event === 'session_completed');
}

const RESULT = JSON.stringify({
  type: 'result', is_error: false, result: 'all done', num_turns: 3, total_cost_usd: 0.5,
  usage: { input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
});
const TOOL_OUTPUT = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'README: on 429 Too Many Requests, back off (rate limit)' }] },
});

describe('session records', () => {
  let cwd: string;
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.turkey'), { recursive: true });
    cwd = mkdtempSync(join(tmpdir(), 'tc-session-'));
    setAuditBuildPhase(undefined);
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('a usage-reporting session returns the reply as stdout and records tokens and cost', async () => {
    const script = `cat > /dev/null; printf '%s\\n' '${TOOL_OUTPUT}' '${RESULT}'`;
    const spawner = new Spawner({ backend: fakeBackend(script, true) });
    setAuditBuildPhase(2);
    const res = await spawner.run({ cwd, prompt: 'hi', sessionName: 'qa-combined-1', model: 'sonnet', timeoutMs: 10_000 });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('all done');
    expect(res.usage).toMatchObject({ outputTokens: 20, cacheReadTokens: 300, costUsd: 0.5, complete: true });
    // Tool output is the app's own content: its wording must not read as an API limit.
    expect(res.rateLimited).toBe(false);
    expect(res.timedOut).toBe(false);

    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0].buildPhase).toBe(2);
    expect(recs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(recs[0].details).toMatchObject({
      session: 'qa-combined-1', stage: 'qa', backend: 'fake', model: 'sonnet', exitCode: 0, timedOut: false,
    });
    expect(recs[0].details.usage).toMatchObject({ outputTokens: 20, costUsd: 0.5 });
  });

  it('an API limit in the reply text is still detected', async () => {
    const err = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' });
    const spawner = new Spawner({ backend: fakeBackend(`cat > /dev/null; printf '%s\\n' '${err}'; exit 1`, true) });
    const res = await spawner.run({ cwd, prompt: 'hi', sessionName: 'plan', timeoutMs: 10_000 });
    expect(res.rateLimited).toBe(true);
    expect(records()[0].details).toMatchObject({ stage: 'plan', rateLimited: true, exitCode: 1 });
  });

  it('a plain-text backend behaves as before and records time only', async () => {
    const spawner = new Spawner({ backend: fakeBackend(`cat > /dev/null; echo plain reply`, false) });
    const res = await spawner.run({ cwd, prompt: 'hi', sessionName: 'research', timeoutMs: 10_000 });
    expect(res.stdout).toBe('plain reply\n');
    expect(res.usage).toBeUndefined();
    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0].details.usage).toBeUndefined();
    expect(recs[0].buildPhase).toBeUndefined();
  });

  it('a session that runs past its timeout is recorded as timed out', async () => {
    const spawner = new Spawner({ backend: fakeBackend(`cat > /dev/null; sleep 30`, false) });
    const res = await spawner.run({ cwd, prompt: 'hi', sessionName: 'build-phase-1', timeoutMs: 300 });
    expect(res.exitCode).toBe(124);
    expect(res.timedOut).toBe(true);
    expect(records()[0].details).toMatchObject({ stage: 'build', timedOut: true });
  }, 15_000);
});

describe('stageOfSession', () => {
  it('maps the session names turkeycode assigns to summary stages', () => {
    const cases: Record<string, string> = {
      'research': 'research',
      'plan': 'plan',
      'build-phase-3': 'build',
      'build-phase-3-retry': 'build',
      'quick-fix-1': 'fix',
      'qa-combined-2': 'qa',
      'qa-visual-capture-1': 'qa',
      'qa-visual-review-1': 'qa',
      'qa-fix-1': 'fix',
      'code-review-4': 'review',
      'merge-fix-phase-2-1': 'merge-fix',
      'polish-1': 'polish',
      'preflight-opus': 'preflight',
      'simulate-fix-2': 'simulate',
      'simulate-spec': 'simulate',
      'planner': 'other',
      'something-else': 'other',
    };
    for (const [name, stage] of Object.entries(cases)) {
      expect(stageOfSession(name), name).toBe(stage);
    }
  });
});

describe('setAsideQaArtifacts', () => {
  it('moves reports, verdicts and done files to a sibling folder and leaves the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-qa-'));
    const qaDir = join(root, 'phase-2');
    mkdirSync(qaDir);
    for (const f of ['verdict-1.json', 'functional-1.md', 'verdict-1.done', 'shot.png']) {
      writeFileSync(join(qaDir, f), f);
    }
    const kept = setAsideQaArtifacts(qaDir, new Date('2026-11-22T10:00:00.000Z'));
    expect(kept).toBe(qaDir + '.prev-2026-11-22T10-00-00-000Z');
    expect(readdirSync(kept!).sort()).toEqual(['functional-1.md', 'verdict-1.done', 'verdict-1.json']);
    expect(readFileSync(join(kept!, 'verdict-1.json'), 'utf-8')).toBe('verdict-1.json');
    expect(readdirSync(qaDir)).toEqual(['shot.png']);
    rmSync(root, { recursive: true, force: true });
  });

  it('does nothing when the folder is missing or has nothing stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-qa-'));
    expect(setAsideQaArtifacts(join(root, 'nope'))).toBeNull();
    mkdirSync(join(root, 'phase-1'));
    expect(setAsideQaArtifacts(join(root, 'phase-1'))).toBeNull();
    expect(readdirSync(root)).toEqual(['phase-1']);
    rmSync(root, { recursive: true, force: true });
  });
});
