/**
 * Code Review prompt builder
 * Job: Review git diff, write review.md, STOP
 */

import { ProjectState } from '../types';
import { REVIEWS_DIR } from '../constants';

export function buildCodeReviewPrompt(
  state: ProjectState,
  phaseNumber: number
): string {
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;

  const reviewPath = `${REVIEWS_DIR}/phase-${phaseNumber}.md`;

  // Get deliverables for context
  const deliverablesSummary = phase
    ? phase.deliverables.map(d => `- ${d}`).join('\n')
    : '- (no deliverables listed)';

  return `
# CODE REVIEW - Phase ${phaseNumber}

## YOUR SINGLE JOB
Review the code changes for this phase. Provide actionable feedback.

---

## CONTEXT

**Phase:** ${phaseName}

### Deliverables in This Phase
${deliverablesSummary}

---

## REVIEW PROCEDURE

### 1. Get the Diff

\`\`\`bash
# Get diff of phase changes vs main
git diff main...HEAD

# Or if PR exists
gh pr diff
\`\`\`

### 2. Review Categories

For each file changed, evaluate:

**Code Quality**
- Is the code readable and well-structured?
- Are functions small and focused?
- Are variable names descriptive?
- Is there unnecessary complexity?

**Correctness**
- Does the code do what the phase requires?
- Are edge cases handled?
- Are error cases handled?

**Security**
- Any SQL injection risks?
- Any XSS vulnerabilities?
- Any exposed secrets?
- Proper input validation?

**Performance**
- Any N+1 queries?
- Any unnecessary re-renders?
- Any memory leaks?
- Any blocking operations?

**Tests**
- Are there tests for new functionality?
- Do tests cover edge cases?
- Are tests meaningful (not just coverage)?

**Patterns**
- Does code follow project conventions?
- Is code consistent with existing patterns?
- Any god files (files doing too much)?

---

## OUTPUT: ${reviewPath}

Create this file with your review:

\`\`\`markdown
# Code Review - Phase ${phaseNumber}: ${phaseName}

**Date:** [timestamp]
**Reviewer:** AI Code Review Agent
**Files Changed:** [count]
**Lines Changed:** +X / -Y

## Summary

[1-2 paragraph overall assessment]

## Files Reviewed

| File | Lines | Assessment | Notes |
|------|-------|------------|-------|
| src/auth/login.ts | +50/-10 | GOOD | Clean implementation |
| src/api/users.ts | +200/-0 | CONCERNS | Missing error handling |

## Findings

### Critical (Must Fix)
1. [File:Line] - [Issue description]
   - Impact: [What could go wrong]
   - Suggestion: [How to fix]

### Warnings (Should Fix)
1. [File:Line] - [Issue description]
   - Suggestion: [How to fix]

### Suggestions (Nice to Have)
1. [File:Line] - [Suggestion]

## Security Review

- [ ] No SQL injection vulnerabilities
- [ ] No XSS vulnerabilities
- [ ] No exposed secrets
- [ ] Input validation present
- [ ] Auth checks in place

## Test Coverage

- [ ] New functionality has tests
- [ ] Edge cases covered
- [ ] Tests are meaningful

## Verdict

**APPROVE** / **REQUEST_CHANGES** / **COMMENT**

[Reasoning for verdict]
\`\`\`

---

## RULES

1. Review ALL changed files
2. Be specific about issues (file:line)
3. Provide actionable suggestions
4. Don't nitpick style (if there's a linter)
5. Focus on correctness and security
6. Do NOT make changes - just review

Then STOP.
`.trim();
}
