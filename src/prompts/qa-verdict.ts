/**
 * QA Verdict prompt builder
 * Job: Read all QA results, write verdict JSON (CLEAN or NEEDS_FIX), STOP
 */

import { ProjectState, shouldSkipVisualQA } from '../types';
import { QA_DIR } from '../constants';
import { readFileSync, existsSync } from 'fs';

export function buildQaVerdictPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  // Look up current phase for scoping
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const deliverables = phase?.deliverables || [];
  const acceptanceCriteria = phase?.acceptanceCriteria || [];

  // Format phase scope
  const deliverablesText = deliverables.length > 0
    ? deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'No specific deliverables listed';

  const acText = acceptanceCriteria.length > 0
    ? acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
    : 'No specific acceptance criteria listed';

  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;

  // Load QA reports
  let smokeReport = '';
  let functionalReport = '';
  let visualReport = '';

  const smokePath = `${qaDir}/smoke-${attempt}.md`;
  const functionalPath = `${qaDir}/functional-${attempt}.md`;
  const visualPath = `${qaDir}/visual-${attempt}.md`;

  if (existsSync(smokePath)) {
    smokeReport = readFileSync(smokePath, 'utf-8');
  }
  if (existsSync(functionalPath)) {
    functionalReport = readFileSync(functionalPath, 'utf-8');
  }
  if (existsSync(visualPath)) {
    visualReport = readFileSync(visualPath, 'utf-8');
  }

  const verdictPath = `${qaDir}/verdict-${attempt}.json`;
  const verdictDone = `${qaDir}/verdict-${attempt}.done`;

  // Load previous verdict for attempt > 1 so verdict agent has continuity
  let previousVerdictContext = '';
  if (attempt > 1) {
    const prevVerdictPath = `${qaDir}/verdict-${attempt - 1}.json`;
    if (existsSync(prevVerdictPath)) {
      try {
        const prevVerdict = JSON.parse(readFileSync(prevVerdictPath, 'utf-8'));
        const prevBlockers = prevVerdict.blockers || [];
        const prevWarnings = prevVerdict.warnings || [];
        const prevFiltered = prevVerdict.filteredOutOfScope || [];
        previousVerdictContext = `
---

## PREVIOUS VERDICT (Attempt ${attempt - 1}) — CONTEXT FOR THIS REVIEW

The previous QA round found these issues and fixes were attempted:

**Previous blockers (${prevBlockers.length}):**
${prevBlockers.map((b: { description: string; location: string }) => `- ${b.description} (${b.location})`).join('\n') || 'None'}

**Previously filtered out-of-scope (${prevFiltered.length}):**
${prevFiltered.map((f: { description: string; reason: string }) => `- ${f.description} — ${f.reason}`).join('\n') || 'None'}

**IMPORTANT for this attempt:**
1. Check if the previous blockers are FIXED. If yes, don't re-add them.
2. Items previously filtered as out-of-scope should STILL be filtered (don't flip-flop).
3. Only add NEW blockers for genuinely broken functionality or spec violations — not for new cosmetic opinions.
4. Visual "warnings" from the visual report go in the **warnings** array, not blockers (unless they break usability or violate the spec).
`;
      } catch { /* ignore parse errors */ }
    }
  }

  return `
# QA VERDICT - Phase ${phaseNumber} (${phaseName}), Attempt ${attempt}

## PHASE SCOPE — READ THIS FIRST
**Phase ${phaseNumber}: ${phaseName}**

### Deliverables for this phase:
${deliverablesText}

### Acceptance Criteria for this phase:
${acText}

**CRITICAL: Filter out any findings about features NOT in this phase's deliverables.**
Only count IN-SCOPE issues as blockers/warnings. Features not listed above are planned
for future phases and have NOT been built yet — findings about them are expected and must be ignored.

---

## YOUR SINGLE JOB
Read ALL QA results, filter out out-of-scope findings, and produce a single verdict: CLEAN or NEEDS_FIX
${previousVerdictContext}
---

## QA REPORTS TO ANALYZE

### Smoke Test Report
\`\`\`markdown
${smokeReport || 'No smoke report found'}
\`\`\`

### Functional Test Report
\`\`\`markdown
${functionalReport || 'No functional report found'}
\`\`\`

${shouldSkipVisualQA(state.projectType || 'web-fullstack')
    ? `### Visual Test Report
*Skipped — project type "${state.projectType}" has no visual component. This is expected and NOT a failure.*`
    : `### Visual Test Report
\`\`\`markdown
${visualReport || 'No visual report found'}
\`\`\``}

---

## STEP 1: FILTER OUT-OF-SCOPE FINDINGS

Before judging, review EVERY finding from ALL reports and categorize:
- **IN-SCOPE**: Related to this phase's deliverables listed above → count these
- **OUT-OF-SCOPE**: About features NOT in this phase's deliverables → ignore these

Common out-of-scope findings to filter:
- Missing features/pages/buttons that are in future phases
- "Not implemented" for functionality not in deliverables

**IMPORTANT: Placeholder pages ARE blockers.** If a page exists in the navigation and displays "coming soon", "future sprints", "will be implemented later", or similar stub text, that IS a blocker — not an out-of-scope finding. Either the page should be fully functional or the nav link should not exist. Users see every page; placeholder text is not shippable.

---

## STEP 2: CLASSIFY ISSUES CORRECTLY

### What goes in BLOCKERS (must fix):
- Dead/broken interactive elements (buttons that don't work, links that 404)
- Failed acceptance criteria
- Crashed/unresponsive pages
- Missing REQUIRED UI elements from the deliverables
- Data loss or security issues
- Spec violations that break intended functionality
- Visual issues that prevent usability (text unreadable, overlapping elements, broken layout)
- Placeholder/stub pages with "coming soon", "future sprint", or "not implemented" text — if the page is linked in the nav, it must be functional or the link must be removed

### What goes in WARNINGS (cosmetic polish):
- Minor alignment/spacing differences
- Subtle color mismatches
- Font inconsistencies that don't affect readability
- Minor responsive differences between viewports
- UX suggestions ("would be better if...")
- Visual polish items from the visual report labeled as WARNING

**DO NOT promote cosmetic warnings to blockers.** A slightly misaligned button is a warning. A button that doesn't work is a blocker.

---

## STEP 3: VERDICT CRITERIA (apply ONLY to in-scope findings)

### CLEAN (can proceed)
- ZERO in-scope blockers across all reports
- All this phase's acceptance criteria pass
- All this phase's core flows work
- No dead interactive elements for this phase's deliverables
- Warnings may exist but are cosmetic only

### NEEDS_FIX (must fix and re-test)
- ANY in-scope blocker in any report
- ANY failed acceptance criteria
- ANY dead interactive element for this phase's deliverables
- This phase's core flow doesn't work

**CLEAN means ZERO blockers. Warnings are acceptable if they are purely cosmetic.**

---

## OUTPUT: ${verdictPath}

Create this JSON file with your verdict:

\`\`\`json
{
  "verdict": "CLEAN",
  "timestamp": "2024-01-15T10:30:00Z",
  "phase": ${phaseNumber},
  "attempt": ${attempt},
  "summary": {
    "smoke": {
      "passed": true,
      "deadElements": 0,
      "errors": 0
    },
    "functional": {
      "passed": true,
      "flowsPassed": 5,
      "flowsFailed": 0,
      "criteriaPassed": 10,
      "criteriaFailed": 0
    },
    "visual": {
      "passed": true,
      "blockers": 0,
      "warnings": 0
    }
  },
  "blockers": [],
  "warnings": [],
  "filteredOutOfScope": [],
  "notes": "All in-scope tests passed. Ready to proceed."
}
\`\`\`

OR if issues found:

\`\`\`json
{
  "verdict": "NEEDS_FIX",
  "timestamp": "2024-01-15T10:30:00Z",
  "phase": ${phaseNumber},
  "attempt": ${attempt},
  "summary": {
    "smoke": {
      "passed": false,
      "deadElements": 2,
      "errors": 1
    },
    "functional": {
      "passed": false,
      "flowsPassed": 3,
      "flowsFailed": 2,
      "criteriaPassed": 8,
      "criteriaFailed": 2
    },
    "visual": {
      "passed": false,
      "blockers": 1,
      "warnings": 3
    }
  },
  "blockers": [
    {
      "type": "functional",
      "description": "Login flow returns 500 error",
      "location": "/api/auth/login",
      "severity": "critical"
    },
    {
      "type": "smoke",
      "description": "Submit button is dead",
      "location": "/login page",
      "severity": "critical"
    }
  ],
  "warnings": [
    {
      "type": "visual",
      "description": "Button color is #3366FF instead of #3333FF",
      "location": "home-desktop.png"
    }
  ],
  "filteredOutOfScope": [
    {
      "type": "smoke",
      "description": "Graph tab has no content",
      "reason": "Graphing is a Phase 3 deliverable, not in scope for this phase"
    }
  ],
  "notes": "Fix ALL in-scope issues (blockers AND warnings) before re-testing. CLEAN = ZERO in-scope issues."
}
\`\`\`

---

## DONE SIGNAL: ${verdictDone}

After writing verdict JSON:
\`\`\`bash
echo "DONE - Verdict completed at $(date -Iseconds)" > ${verdictDone}
\`\`\`

---

## RULES

1. Read ALL three QA reports
2. **Filter first** - Remove findings about features NOT in this phase's deliverables
3. **Classify correctly** - Broken functionality → blockers. Cosmetic polish → warnings. Do NOT mix them.
4. **Blockers array** - ONLY broken functionality, dead elements, failed acceptance criteria, spec-violating issues that prevent usability
5. **Warnings array** - Cosmetic issues: alignment, spacing, color, font, minor responsive differences, UX suggestions
6. List ALL filtered out-of-scope findings in filteredOutOfScope array with reason
7. The verdict JSON must be valid JSON
8. Do NOT fix anything - just judge
9. **NEEDS_FIX only if blockers > 0** - Cosmetic warnings alone do NOT trigger NEEDS_FIX

Then STOP.
`.trim();
}
