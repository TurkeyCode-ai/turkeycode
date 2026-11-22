/**
 * Review-fix prompt builder
 * Job: fix the critical findings of this phase's code review, nothing else.
 */

import { ProjectState } from '../types';
import { oneTurnRule } from './one-turn';
import { REVIEWS_DIR } from '../constants';
import { ReviewFinding } from '../review-findings';

export function buildReviewFixPrompt(
  state: ProjectState,
  phaseNumber: number,
  critical: ReviewFinding[]
): string {
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const reportPath = `${REVIEWS_DIR}/phase-${phaseNumber}-fixes.md`;
  const doneFile = `${REVIEWS_DIR}/phase-${phaseNumber}-fix.done`;

  const findingsText = critical
    .map((f, i) => {
      const lines = [`### ${i + 1}. ${f.file || '(no file given)'}`, `Issue: ${f.issue}`];
      if (f.impact) lines.push(`Impact: ${f.impact}`);
      if (f.suggestion) lines.push(`Reviewer's suggestion: ${f.suggestion}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `
# REVIEW FIX - Phase ${phaseNumber}: ${phaseName}

## YOUR SINGLE JOB
This phase passed QA. A code review of it then found the critical issues below. Fix those issues, and only those. **DO NOT touch \`.turkey/state.json\`**.

The full review is at \`${REVIEWS_DIR}/phase-${phaseNumber}.md\` if you need its context.

---

## CRITICAL FINDINGS

${findingsText}

---

## RULES

1. Check each finding against the code first. A reviewer can be wrong: if a finding does not hold, change nothing for it and say why in the report.
2. Fix the cause, in the smallest change that fixes it. Do not refactor, rename, restyle or tidy anything else.
3. Do not weaken, skip or delete a test to make a fix pass. If a fix changes behaviour a test covers, update the test to the correct behaviour.
4. Do not act on the review's warnings or suggestions. Only the findings listed above.
5. Run the project's tests and build before you finish. The phase goes through QA again after you.
6. Commit your changes with a message starting \`review-fix:\`.

## OUTPUT

Write \`${reportPath}\`: for each finding, one line saying what you changed, or that you changed nothing and why.

Then create \`${doneFile}\`.

${oneTurnRule('the fix report')}

Then STOP.
`.trim();
}
