/**
 * QA Fix prompt builder
 * Job: Fix ALL issues - blockers AND warnings. CLEAN means ZERO issues.
 */

import { ProjectState } from '../types';
import { QA_DIR } from '../constants';
import { readFileSync, existsSync } from 'fs';

export function buildQaFixPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  // Look up current phase for scoping
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const deliverables = phase?.deliverables || [];

  // Format deliverables list
  const deliverablesText = deliverables.length > 0
    ? deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'No specific deliverables listed';

  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const verdictPath = `${qaDir}/verdict-${attempt}.json`;
  const smokePath = `${qaDir}/smoke-${attempt}.md`;
  const fixReport = `${qaDir}/fixes-${attempt}.md`;
  const fixDone = `${qaDir}/fix-${attempt}.done`;

  // Load verdict to get all issues
  let verdict: {
    blockers?: Array<{ type: string; description: string; location: string; severity?: string }>;
    warnings?: Array<{ type: string; description: string; location: string }>;
  } = {};

  if (existsSync(verdictPath)) {
    try {
      verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
    } catch {
      // Ignore parse errors
    }
  }

  let blockers = verdict.blockers || [];
  const warnings = verdict.warnings || [];

  // FALLBACK: If no blockers from verdict, try to read smoke report directly
  let smokeReportContent = '';
  if (existsSync(smokePath)) {
    smokeReportContent = readFileSync(smokePath, 'utf-8');

    // If blockers empty but smoke report shows failures, add generic blocker
    if (blockers.length === 0 && (smokeReportContent.includes('FAIL') || smokeReportContent.includes('BLOCKER'))) {
      blockers = [{
        type: 'smoke',
        description: 'See smoke report below for details',
        location: smokePath,
        severity: 'critical'
      }];
    }
  }
  const totalIssues = blockers.length + warnings.length;

  // Load previous attempt history so fix agent doesn't repeat failed approaches
  let previousAttemptsText = '';
  if (attempt > 1) {
    const histories: string[] = [];
    for (let prev = 1; prev < attempt; prev++) {
      const parts: string[] = [];
      const prevVerdictPath = `${qaDir}/verdict-${prev}.json`;
      const prevFixReport = `${qaDir}/fixes-${prev}.md`;
      const prevSmokePath = `${qaDir}/smoke-${prev}.md`;

      if (existsSync(prevVerdictPath)) {
        try {
          const prevVerdict = JSON.parse(readFileSync(prevVerdictPath, 'utf-8'));
          const prevBlockers = prevVerdict.blockers || [];
          const prevWarnings = prevVerdict.warnings || [];
          parts.push(`**Verdict:** ${prevVerdict.verdict} (${prevBlockers.length} blockers, ${prevWarnings.length} warnings)`);
          if (prevBlockers.length > 0) {
            parts.push('**Blockers found:**\n' + prevBlockers.map((b: { description: string }) => `- ${b.description}`).join('\n'));
          }
        } catch { /* ignore */ }
      }

      if (existsSync(prevFixReport)) {
        const report = readFileSync(prevFixReport, 'utf-8');
        // Truncate long reports to avoid blowing up the prompt
        const truncated = report.length > 3000 ? report.slice(0, 3000) + '\n\n... (truncated)' : report;
        parts.push(`**Fix report:**\n\`\`\`markdown\n${truncated}\n\`\`\``);
      }

      if (existsSync(prevSmokePath)) {
        const smoke = readFileSync(prevSmokePath, 'utf-8');
        const truncated = smoke.length > 2000 ? smoke.slice(0, 2000) + '\n\n... (truncated)' : smoke;
        parts.push(`**Smoke report:**\n\`\`\`markdown\n${truncated}\n\`\`\``);
      }

      if (parts.length > 0) {
        histories.push(`### Attempt ${prev}\n${parts.join('\n\n')}`);
      }
    }

    if (histories.length > 0) {
      previousAttemptsText = `
---

## PREVIOUS FAILED ATTEMPTS — READ CAREFULLY

The following fixes were already tried and DID NOT WORK. QA found the same or similar issues afterward.
**You MUST take a DIFFERENT approach.** Do not repeat the same fixes. If the previous attempt patched a symptom, fix the root cause instead.

${histories.join('\n\n')}

**KEY TAKEAWAY: Whatever was tried above did not resolve the issues. Analyze WHY it failed and try a fundamentally different approach.**
`;
    }
  }

  // Format all issues
  const blockersText = blockers.length > 0
    ? blockers.map((b, i) => `${i + 1}. [BLOCKER] ${b.description} (${b.location})`).join('\n')
    : 'None';

  const warningsText = warnings.length > 0
    ? warnings.map((w, i) => `${i + 1}. [WARNING] ${w.description} (${w.location})`).join('\n')
    : 'None';

  return `
# QA FIX - Phase ${phaseNumber} (${phaseName}), Attempt ${attempt}

## PHASE SCOPE — READ THIS FIRST
**Phase ${phaseNumber}: ${phaseName}**

### Deliverables for this phase:
${deliverablesText}

**CRITICAL: Only fix issues related to this phase's deliverables listed above.**
Ignore findings about features from future phases — those have NOT been built yet and are expected to be missing.
If a finding is about a feature NOT in the deliverables list, skip it.

---

## YOUR SINGLE JOB
Fix ALL in-scope issues. CLEAN means ZERO in-scope issues - not "pretty good", not "mostly done". ZERO.

---

## ISSUES TO FIX (${totalIssues} total — filter out any that are out-of-scope)

### BLOCKERS (${blockers.length}) - Fix these FIRST
${blockersText}

### WARNINGS (${warnings.length}) - Fix these AFTER blockers
${warningsText}
${previousAttemptsText}
${smokeReportContent ? `
---

## SMOKE TEST REPORT (raw details)

Read this carefully - it contains the root cause information:

\`\`\`markdown
${smokeReportContent}
\`\`\`
` : ''}
---

## PHILOSOPHY

**Warnings are NOT optional.**

A shipped product with known warnings is not clean. Polish matters.
Users notice misaligned buttons. Users notice inconsistent spacing.
Ship nothing you wouldn't be proud of.

---

## FIX PROCEDURE

### Step 1: Fix ALL Blockers First

For EACH blocker:
1. **Locate** - Find the code causing the issue
2. **Understand** - Why is it broken?
3. **Fix** - Make the minimal change to fix it
4. **Verify** - Test that it's actually fixed
5. **Move on** - Don't over-engineer, just fix

### Step 2: Fix ALL Warnings

For EACH warning:
1. **Locate** - Find where the issue is
2. **Fix** - Alignment, spacing, colors, whatever it is
3. **Verify** - Visual check that it's resolved

### Step 3: Verify Everything

Run through the app one more time:
- Every blocker should be resolved
- Every warning should be resolved
- No new issues introduced

---

## OUTPUT: ${fixReport}

Create this file documenting ALL fixes:

\`\`\`markdown
# Fix Report - Phase ${phaseNumber}, Attempt ${attempt}

**Date:** [timestamp]
**Blockers Fixed:** ${blockers.length}
**Warnings Fixed:** ${warnings.length}
**Total Issues Resolved:** ${totalIssues}

## Blocker Fixes

${blockers.map((b, i) => `
### Blocker ${i + 1}: ${b.description}
- **Location:** ${b.location}
- **Root Cause:** [why it was broken]
- **Files Changed:** [list]
- **Fix Applied:** [what you changed]
- **Verified:** YES
`).join('\n')}

## Warning Fixes

${warnings.map((w, i) => `
### Warning ${i + 1}: ${w.description}
- **Location:** ${w.location}
- **Fix Applied:** [what you changed]
- **Verified:** YES
`).join('\n')}

## Verification Checklist

All issues resolved:
${blockers.map((b, i) => `- [x] BLOCKER ${i + 1}: ${b.description}`).join('\n')}
${warnings.map((w, i) => `- [x] WARNING ${i + 1}: ${w.description}`).join('\n')}

## Commit

\`\`\`bash
git add -A
git commit -m "fix: resolve ${totalIssues} QA issues (${blockers.length} blockers, ${warnings.length} warnings)"
\`\`\`
\`\`\`

---

## DONE SIGNAL: ${fixDone}

After fixing ALL issues (blockers AND warnings):
\`\`\`bash
echo "DONE - All ${totalIssues} issues fixed at $(date -Iseconds)" > ${fixDone}
\`\`\`

---

## RULES

1. **Fix in-scope issues ONLY** - Skip findings about features not in this phase's deliverables
2. **Blockers first** - Then ALL in-scope warnings
3. **No skipping in-scope issues** - Every in-scope issue gets resolved
4. **Verify each fix** - Don't assume it worked
5. **Minimal changes** - Fix the issue, don't refactor
6. **No new features** - Just fix what's broken, don't build future-phase features
7. **Commit when done** - Clean atomic commit

**CLEAN = ZERO in-scope issues. Not "acceptable". ZERO.**

Then STOP.
`.trim();
}
