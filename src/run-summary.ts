/**
 * End-of-run summary: where a run spent its time, tokens and money.
 *
 * Built only from the `session_completed` records the spawner writes to the
 * audit log, so it covers every session of the run and needs no bookkeeping
 * at the call sites. The aggregation is pure; reading the log and formatting
 * the table are kept apart from it.
 */

import { existsSync, readFileSync } from 'fs';
import type { SessionUsage } from './agents/usage';

/** One session as the audit log recorded it. */
export interface SessionEntry {
  timestamp: string;
  session: string;
  stage: string;
  buildPhase?: number;
  model?: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  usage?: SessionUsage;
}

export interface SummaryRow {
  sessions: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the costs that were reported. */
  costUsd: number;
  /** Sessions whose cost the CLI reported. */
  sessionsWithCost: number;
  /** Sessions that reported any token figures. */
  sessionsWithTokens: number;
  /** Sessions whose figures are a lower bound (ended before the CLI's total). */
  partialSessions: number;
  timedOut: number;
}

export interface RunSummary {
  total: SummaryRow;
  /** In order of first appearance. */
  byStage: Array<{ stage: string } & SummaryRow>;
  /** Ascending by phase number; sessions outside any phase are not listed here. */
  byPhase: Array<{ buildPhase: number } & SummaryRow>;
}

/** Audit events that begin a run: the summary covers what follows the last one. */
const RUN_START_EVENTS = new Set(['orchestration_started', 'ticket_run_started', 'story_started']);

/** Stages that run ahead of the start event but are part of the run. */
const LEAD_IN_STAGES = new Set(['scope', 'preflight']);

function emptyRow(): SummaryRow {
  return {
    sessions: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    sessionsWithCost: 0,
    sessionsWithTokens: 0,
    partialSessions: 0,
    timedOut: 0,
  };
}

function add(row: SummaryRow, s: SessionEntry): void {
  row.sessions++;
  row.durationMs += s.durationMs;
  if (s.timedOut) row.timedOut++;
  const u = s.usage;
  if (!u) return;
  row.sessionsWithTokens++;
  row.inputTokens += u.inputTokens;
  row.outputTokens += u.outputTokens;
  row.cacheReadTokens += u.cacheReadTokens;
  row.cacheWriteTokens += u.cacheWriteTokens;
  if (!u.complete) row.partialSessions++;
  if (typeof u.costUsd === 'number') {
    row.costUsd += u.costUsd;
    row.sessionsWithCost++;
  }
}

/**
 * The sessions of the most recent run in an audit log (JSON lines). A resumed
 * run belongs to the run it resumes, so only a fresh start resets the list.
 * Lines that are not valid records are skipped.
 */
export function sessionsOfLastRun(auditLogText: string): SessionEntry[] {
  let sessions: SessionEntry[] = [];
  for (const line of auditLogText.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.event === 'string' && RUN_START_EVENTS.has(entry.event)) {
      // Scope turns and the startup probes run before the start event is
      // written, and they belong to the run they lead into: keep the
      // unbroken tail of them.
      let from = sessions.length;
      while (from > 0 && LEAD_IN_STAGES.has(sessions[from - 1].stage)) from--;
      sessions = sessions.slice(from);
      continue;
    }
    if (entry.event !== 'session_completed') continue;
    const d = entry.details as Record<string, unknown> | undefined;
    if (!d || typeof d.session !== 'string') continue;
    sessions.push({
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      session: d.session,
      stage: typeof d.stage === 'string' ? d.stage : 'other',
      buildPhase: typeof entry.buildPhase === 'number' ? entry.buildPhase : undefined,
      model: typeof d.model === 'string' ? d.model : undefined,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
      exitCode: typeof d.exitCode === 'number' ? d.exitCode : 0,
      timedOut: d.timedOut === true,
      usage: d.usage && typeof d.usage === 'object' ? (d.usage as SessionUsage) : undefined,
    });
  }
  return sessions;
}

export function summarize(sessions: SessionEntry[]): RunSummary {
  const total = emptyRow();
  const stages = new Map<string, SummaryRow>();
  const phases = new Map<number, SummaryRow>();
  for (const s of sessions) {
    add(total, s);
    if (!stages.has(s.stage)) stages.set(s.stage, emptyRow());
    add(stages.get(s.stage)!, s);
    if (s.buildPhase !== undefined) {
      if (!phases.has(s.buildPhase)) phases.set(s.buildPhase, emptyRow());
      add(phases.get(s.buildPhase)!, s);
    }
  }
  return {
    total,
    byStage: [...stages.entries()].map(([stage, row]) => ({ stage, ...row })),
    byPhase: [...phases.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([buildPhase, row]) => ({ buildPhase, ...row })),
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function tokenCells(row: SummaryRow): [string, string, string] {
  if (row.sessionsWithTokens === 0) return ['not recorded', '', ''];
  return [
    formatTokens(row.outputTokens),
    formatTokens(row.cacheReadTokens),
    formatTokens(row.inputTokens + row.cacheWriteTokens),
  ];
}

function costCell(row: SummaryRow): string {
  if (row.sessionsWithCost === 0) return 'not reported';
  const cost = '$' + row.costUsd.toFixed(2);
  // Say so when the figure leaves sessions out, never present it as the whole.
  return row.sessionsWithCost < row.sessions
    ? `${cost} (${row.sessionsWithCost} of ${row.sessions})`
    : cost;
}

/** The summary as aligned plain text, one line per array entry. */
export function formatRunSummary(summary: RunSummary): string[] {
  if (summary.total.sessions === 0) return ['Run summary: no sessions recorded.'];
  const header = ['', 'sessions', 'time', 'output', 'cache read', 'input+write', 'cost'];
  const line = (label: string, row: SummaryRow): string[] => {
    const [out, read, written] = tokenCells(row);
    return [label, String(row.sessions), formatDuration(row.durationMs), out, read, written, costCell(row)];
  };
  const rows: string[][] = [header];
  for (const s of summary.byStage) rows.push(line(s.stage, s));
  rows.push(line('total', summary.total));
  const phaseRows: string[][] = summary.byPhase.map((p) => line(`phase ${p.buildPhase}`, p));

  const widths = header.map((_, i) =>
    Math.max(...[...rows, ...phaseRows].map((r) => r[i].length))
  );
  const render = (r: string[]): string =>
    r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd();

  const out: string[] = ['Run summary (session time, tokens, and cost as reported by the CLI)'];
  for (const r of rows) out.push(render(r));
  if (phaseRows.length > 0) {
    out.push('');
    out.push('By build phase');
    for (const r of phaseRows) out.push(render(r));
  }
  const notes: string[] = [];
  if (summary.total.partialSessions > 0) {
    notes.push(
      `${summary.total.partialSessions} session(s) ended before the CLI reported its total: ` +
      'their tokens are a lower bound and their cost is not included.'
    );
  }
  if (summary.total.timedOut > 0) {
    notes.push(`${summary.total.timedOut} session(s) ran out of time.`);
  }
  if (notes.length > 0) {
    out.push('');
    out.push(...notes);
  }
  return out;
}

/** Read an audit log and summarize its most recent run. A missing log is an empty run. */
export function summarizeAuditLog(path: string): RunSummary {
  if (!existsSync(path)) return summarize([]);
  return summarize(sessionsOfLastRun(readFileSync(path, 'utf-8')));
}
