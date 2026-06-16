/**
 * Audit logging for turkey-enterprise-v3
 * Append-only log for compliance and SOC 2 evidence
 * Phase-based orchestrator model
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { AUDIT_LOG } from './constants';

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
  | 'jira_sprint_created'
  | 'jira_ticket_created'
  | 'jira_time_logged'
  | 'github_branch_created'
  | 'github_pr_created'
  | 'github_pr_merged'
  | 'ticket_run_started'
  | 'ticket_triage'
  | 'ticket_research_posted'
  | 'ticket_branch_pushed'
  | 'ticket_run_completed';

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
