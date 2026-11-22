/**
 * What a phase's code review found, in a form the orchestrator can act on.
 *
 * The review session writes its report for people (phase-N.md) and, beside
 * it, a small JSON file with its verdict and findings. Which findings are
 * critical is the reviewer's judgement; the orchestrator only reads fields.
 *
 * Reviews used to be written and never read: 5 of 47 past reviews listed
 * must-fix issues and every one of those phases merged unchanged.
 */

import { existsSync, readFileSync } from 'fs';

export interface ReviewFinding {
  file: string;
  issue: string;
  impact?: string;
  suggestion?: string;
}

export interface ReviewFindings {
  verdict: string;
  critical: ReviewFinding[];
  warnings: ReviewFinding[];
}

function asFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    if (typeof f.issue !== 'string' || !f.issue.trim()) continue;
    out.push({
      file: typeof f.file === 'string' ? f.file : '',
      issue: f.issue,
      impact: typeof f.impact === 'string' ? f.impact : undefined,
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
    });
  }
  return out;
}

/** Parse the review's JSON. Null when it is not an object: nothing can be read from it. */
export function parseReviewFindings(text: string): ReviewFindings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  return {
    verdict: typeof r.verdict === 'string' ? r.verdict : '',
    critical: asFindings(r.critical),
    warnings: asFindings(r.warnings),
  };
}

/**
 * Read a review's findings file. Null means "not recorded" (missing or
 * unreadable), which is not the same as "found nothing".
 */
export function readReviewFindings(path: string): ReviewFindings | null {
  if (!existsSync(path)) return null;
  try {
    return parseReviewFindings(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export type ReviewAction = 'fix' | 'none' | 'already-attempted';

/**
 * Act on a review at most once per phase. A resumed phase is reviewed again,
 * and a second round of fix-and-QA on the same phase is how loops start.
 */
export function reviewAction(
  findings: ReviewFindings | null,
  alreadyAttempted: boolean
): ReviewAction {
  if (!findings || findings.critical.length === 0) return 'none';
  return alreadyAttempted ? 'already-attempted' : 'fix';
}
