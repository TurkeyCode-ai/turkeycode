/**
 * Audit logging for turkeycode
 * Append-only log for compliance and SOC 2 evidence
 * Phase-based orchestrator model
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { AUDIT_LOG } from './constants';
import type { SessionUsage } from './agents/usage';

export type AuditEvent =
  | 'orchestration_started'
  | 'orchestration_resumed'
  | 'orchestration_completed'
  | 'phase_started'
  | 'phase_completed'
  | 'gate_passed'
  | 'gate_failed'
  | 'build_phase_started'
  | 'build_phase_completed'
  | 'qa_attempt_started'
  | 'qa_passed'
  | 'qa_failed'
  | 'fix_started'
  | 'fix_completed'
  | 'fix_reverted'
  | 'fix_noop'
  | 'session_completed'
  | 'jira_sprint_created'
  | 'jira_ticket_created'
  | 'jira_time_logged'
  | 'github_branch_created'
  | 'github_pr_created'
  | 'github_pr_merged'
  | 'phase_merge_fixed'
  | 'ticket_run_started'
  | 'ticket_triage'
  | 'ticket_scope_resolved'
  | 'ticket_research_posted'
  | 'ticket_branch_pushed'
  | 'ticket_branch_local'
  | 'ticket_run_completed'
  | 'story_started'
  | 'story_ticket_created';

export interface AuditEntry {
  timestamp: string;
  event: AuditEvent;
  phase?: string;
  buildPhase?: number;
  gate?: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}

/**
 * The build phase the run is working on, stamped on every session record so
 * the run summary can group sessions whose names carry no phase number
 * ('qa-combined-1'). The orchestrator sets it when a phase starts and clears
 * it when the phase ends.
 */
let currentBuildPhase: number | undefined;
export function setAuditBuildPhase(buildPhase: number | undefined): void {
  currentBuildPhase = buildPhase;
}

/**
 * Stage names for the run summary, longest prefix first. These are session
 * names turkeycode itself assigns, never agent or user text.
 */
const SESSION_STAGES: Array<[prefix: string, stage: string]> = [
  ['qa-visual', 'qa'],
  ['qa-combined', 'qa'],
  ['qa-smoke', 'qa'],
  ['qa-functional', 'qa'],
  ['qa-verdict', 'qa'],
  ['qa-fix', 'fix'],
  ['quick-fix', 'fix'],
  ['merge-fix', 'merge-fix'],
  ['build', 'build'],
  ['code-review', 'review'],
  ['review-fix', 'fix'],
  ['review', 'review'],
  ['fix', 'fix'],
  ['polish', 'polish'],
  ['preflight', 'preflight'],
  ['research', 'research'],
  ['plan', 'plan'],
  ['scope', 'scope'],
  ['aar', 'aar'],
  ['simulate', 'simulate'],
  ['triage', 'triage'],
  ['estimate', 'estimate'],
];

export function stageOfSession(sessionName: string): string {
  for (const [prefix, stage] of SESSION_STAGES) {
    if (sessionName === prefix || sessionName.startsWith(prefix + '-')) return stage;
  }
  return 'other';
}

export interface SessionRecord {
  session: string;
  stage: string;
  backend: string;
  model?: string;
  exitCode: number;
  timedOut: boolean;
  rateLimited: boolean;
  creditExhausted: boolean;
  usage?: SessionUsage;
}

/**
 * Record one finished agent session: how long it ran and what it used.
 * Written by the spawner, so every session of every command is covered.
 * Recording must never fail a run.
 */
export function auditSession(record: SessionRecord, durationMs: number): void {
  try {
    audit('session_completed', {
      buildPhase: currentBuildPhase,
      durationMs,
      details: { ...record },
    });
  } catch {
    // An unwritable audit log must not take the session's result with it.
  }
}

/**
 * Append an entry to the audit log
 * Format: JSON Lines (one JSON object per line)
 */
export function audit(event: AuditEvent, data: Omit<AuditEntry, 'timestamp' | 'event'> = {}): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...data
  };

  // Ensure directory exists
  const dir = dirname(AUDIT_LOG);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Append as JSON Line
  appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
}

/**
 * Log a gate check result
 */
export function auditGate(gate: string, passed: boolean, details?: Record<string, unknown>): void {
  audit(passed ? 'gate_passed' : 'gate_failed', {
    gate,
    details
  });
}

/**
 * Log phase transition
 */
export function auditPhase(phase: string, action: 'started' | 'completed', details?: Record<string, unknown>): void {
  audit(action === 'started' ? 'phase_started' : 'phase_completed', {
    phase,
    details
  });
}

/**
 * Log build phase events
 */
export function auditBuildPhase(
  buildPhase: number,
  action: 'started' | 'completed',
  details?: Record<string, unknown>
): void {
  audit(action === 'started' ? 'build_phase_started' : 'build_phase_completed', {
    buildPhase,
    details
  });
}

/**
 * Log QA events
 */
export function auditQA(
  buildPhase: number,
  attempt: number,
  action: 'started' | 'passed' | 'failed',
  details?: Record<string, unknown>
): void {
  const event = action === 'started' ? 'qa_attempt_started'
    : action === 'passed' ? 'qa_passed'
    : 'qa_failed';
  audit(event, {
    buildPhase,
    details: { attempt, ...details }
  });
}
