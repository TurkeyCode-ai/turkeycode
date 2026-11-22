import { describe, it, expect } from 'vitest';
import {
  sessionsOfLastRun,
  summarize,
  formatRunSummary,
  formatDuration,
  formatTokens,
} from '../run-summary';

const session = (
  name: string,
  stage: string,
  durationMs: number,
  usage?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  buildPhase?: number
) =>
  JSON.stringify({
    timestamp: '2026-11-22T10:00:00.000Z',
    event: 'session_completed',
    buildPhase,
    durationMs,
    details: { session: name, stage, backend: 'claude', exitCode: 0, timedOut: false, usage, ...extra },
  });

const full = (out: number, read: number, cost: number) => ({
  inputTokens: 10,
  outputTokens: out,
  cacheReadTokens: read,
  cacheWriteTokens: 100,
  costUsd: cost,
  complete: true,
});

describe('sessionsOfLastRun', () => {
  it('keeps only sessions after the last fresh start; a resume does not reset', () => {
    const log = [
      JSON.stringify({ event: 'orchestration_started' }),
      session('plan', 'plan', 1000),
      JSON.stringify({ event: 'orchestration_started' }),
      session('research', 'research', 2000),
      JSON.stringify({ event: 'orchestration_resumed' }),
      session('build-phase-1', 'build', 3000, undefined, {}, 1),
      'not json',
      JSON.stringify({ event: 'session_completed' }), // no details: skipped
      '',
    ].join('\n');
    const sessions = sessionsOfLastRun(log);
    expect(sessions.map((s) => s.session)).toEqual(['research', 'build-phase-1']);
    expect(sessions[1].buildPhase).toBe(1);
  });

  it('scope turns and startup probes just before a start belong to that run', () => {
    const log = [
      JSON.stringify({ event: 'orchestration_started' }),
      session('build-phase-1', 'build', 1000),
      session('scope', 'scope', 500),
      session('preflight-opus', 'preflight', 300),
      session('preflight-sonnet', 'preflight', 300),
      JSON.stringify({ event: 'orchestration_started' }),
      session('plan', 'plan', 2000),
    ].join('\n');
    expect(sessionsOfLastRun(log).map((s) => s.session)).toEqual([
      'scope', 'preflight-opus', 'preflight-sonnet', 'plan',
    ]);
  });

  it('a log with no start event counts every session', () => {
    expect(sessionsOfLastRun([session('a', 'qa', 1), session('b', 'qa', 1)].join('\n'))).toHaveLength(2);
  });
});

describe('summarize', () => {
  const sessions = sessionsOfLastRun(
    [
      session('preflight-opus', 'preflight', 5_000, full(1, 1000, 0.01)),
      session('build-phase-1', 'build', 600_000, {
        inputTokens: 5, outputTokens: 4000, cacheReadTokens: 2_000_000, cacheWriteTokens: 50_000, complete: false,
      }, {}, 1),
      session('qa-combined-1', 'qa', 40_000, full(500, 300_000, 0.4), {}, 1),
      session('qa-visual-capture-1', 'qa', 45_000, full(300, 200_000, 0.3), { timedOut: true }, 1),
      session('code-review-1', 'review', 20_000, undefined, {}, 1),
      session('polish-1', 'polish', 12_000, full(100, 50_000, 0.05)),
    ].join('\n')
  );
  const summary = summarize(sessions);

  it('totals time, tokens and cost, and counts what is missing', () => {
    expect(summary.total.sessions).toBe(6);
    expect(summary.total.durationMs).toBe(722_000);
    expect(summary.total.outputTokens).toBe(4901);
    expect(summary.total.cacheReadTokens).toBe(2_551_000);
    expect(summary.total.costUsd).toBeCloseTo(0.76, 10);
    expect(summary.total.sessionsWithCost).toBe(4);
    expect(summary.total.sessionsWithTokens).toBe(5);
    expect(summary.total.partialSessions).toBe(1);
    expect(summary.total.timedOut).toBe(1);
  });

  it('groups by stage in order of first appearance and by phase number', () => {
    expect(summary.byStage.map((s) => s.stage)).toEqual(['preflight', 'build', 'qa', 'review', 'polish']);
    expect(summary.byStage.find((s) => s.stage === 'qa')).toMatchObject({ sessions: 2, durationMs: 85_000 });
    // Preflight and polish ran outside any phase.
    expect(summary.byPhase).toHaveLength(1);
    expect(summary.byPhase[0]).toMatchObject({ buildPhase: 1, sessions: 4 });
  });

  it('never presents a partial cost as the whole, and says what was not recorded', () => {
    const text = formatRunSummary(summary).join('\n');
    expect(text).toContain('as reported by the CLI');
    expect(text).toMatch(/total\s+6\s+12m 02s .*\$0\.76 \(4 of 6\)/);
    expect(text).toMatch(/review\s+1\s+20s\s+not recorded\s+not reported/);
    expect(text).toMatch(/build\s+1\s+10m 00s .*not reported/);
    expect(text).toContain('1 session(s) ended before the CLI reported its total');
    expect(text).toContain('1 session(s) ran out of time.');
    expect(text).toContain('By build phase');
    expect(text).not.toContain('—');
  });

  it('an empty run says so', () => {
    expect(formatRunSummary(summarize([]))).toEqual(['Run summary: no sessions recorded.']);
  });
});

describe('formatting', () => {
  it('durations', () => {
    expect(formatDuration(900)).toBe('1s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });
  it('tokens', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(30_100_000)).toBe('30.1M');
  });
});
