/**
 * After-Action Review (AAR) prompt builder
 * Job: Summarize phase by writing the user-facing AAR markdown, write aar.done, STOP.
 * The agent must NOT touch state.json — the orchestrator owns that file and concurrent
 * edits corrupt it, which kills the phase loop with "Could not parse state.json".
 */

import { ProjectState } from '../types';
import { AAR_DIR } from '../constants';

export function buildAarPrompt(
  state: ProjectState,
  phaseNumber: number
): string {
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;

  const aarPath = `docs/aar/phase-${phaseNumber}.md`;
  const aarDone = `${AAR_DIR}/phase-${phaseNumber}.done`;

  // Get phase deliverables summary
  const deliverablesSummary = phase
    ? phase.deliverables.map(d => `- ${d}`).join('\n')
    : '- (no deliverables listed)';

  // Current tech context
  const currentTech = Object.keys(state.tech).length > 0
    ? JSON.stringify(state.tech, null, 2)
    : '{}';

  return `
# AFTER-ACTION REVIEW - Phase ${phaseNumber}

## YOUR SINGLE JOB
Document what was built in a user-facing markdown report. **DO NOT touch \`.turkey/state.json\`** — the orchestrator owns that file and concurrent edits corrupt it.

---

## CONTEXT

**Phase:** ${phaseNumber} - ${phaseName}

### Deliverables
${deliverablesSummary}

### Current Tech Context
\`\`\`json
${currentTech}
\`\`\`

---

## AAR PROCEDURE

### 1. Gather Metrics

\`\`\`bash
# Git stats
git log --oneline main..HEAD
git diff --stat main..HEAD
\`\`\`

### 2. Analyze What Was Built

Look at the code to identify:
- New entities/models created
- New API endpoints added
- New UI pages/components
- New dependencies added
- New conventions established
- Known issues discovered

---

## OUTPUT: ${aarPath}

Create this file:

\`\`\`markdown
# Phase ${phaseNumber} After-Action Review

**Phase:** ${phaseName}
**Date:** [timestamp]
**Duration:** [start to end]

## Summary

[2-3 paragraphs summarizing what was accomplished]

## What Was Built

### Entities/Models
- [Entity]: [description]

### API Endpoints
- [Endpoint]: [description]

### UI Pages
- [Page]: [description]

### Key Dependencies Added
- [Dependency]: [why]

## What Went Well

1. [Item]
2. [Item]

## What Could Improve

1. [Item]
2. [Item]

## Key Decisions Made

| Decision | Rationale | Impact |
|----------|-----------|--------|
| Used X | Because Y | Z |

## Tech Debt Created

1. [Debt]: [why acceptable now]

## Known Issues

1. [Issue]: [workaround if any]

## Recommendations for Next Phase

1. [Recommendation]

## Metrics

- Lines of code: +X / -Y
- Files changed: Z
- Test coverage: X%
\`\`\`

---

## DONE SIGNAL: ${aarDone}

After creating the AAR markdown:
\`\`\`bash
mkdir -p ${AAR_DIR}
echo "DONE - AAR completed at $(date -Iseconds)" > ${aarDone}
\`\`\`

---

## RULES

1. Read ALL code changes for the phase
2. Be thorough in documenting what was built
3. **DO NOT touch \`.turkey/state.json\`** — concurrent edits corrupt it and break the orchestrator
4. Do NOT start next phase - just document this one

Then STOP.
`.trim();
}
