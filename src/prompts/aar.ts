/**
 * After-Action Review (AAR) prompt builder
 * Job: Summarize phase, update state.json with what was built, write aar.done, STOP
 */

import { ProjectState } from '../types';
import { AAR_DIR, STATE_FILE } from '../constants';

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
Document what was built and update state.json for future sessions.

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

### 3. Update state.json

Read and update ${STATE_FILE} with:

\`\`\`json
{
  "tech": {
    "backend": "Express 4.18",
    "frontend": "React 18",
    "database": "PostgreSQL 15",
    "orm": "Prisma 5",
    "packageManager": "npm",
    "dependencies": {
      "express": "^4.18.0",
      "react": "^18.2.0"
    },
    "ports": {
      "dev": 3000,
      "api": 4000
    },
    "buildCommands": {
      "dev": "npm run dev",
      "build": "npm run build",
      "test": "npm test"
    },
    "conventions": [
      "REST API uses /api prefix",
      "Components in PascalCase",
      "Hooks prefixed with use"
    ]
  },
  "entities": ["User", "Post", "Comment"],
  "endpoints": ["/api/auth/login", "/api/users", "/api/posts"],
  "uiPages": ["/", "/login", "/dashboard"],
  "knownIssues": [
    "Mobile layout breaks below 320px"
  ]
}
\`\`\`

---

## OUTPUT 1: ${aarPath}

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

## OUTPUT 2: Update ${STATE_FILE}

Update the following fields based on your analysis:
- tech (with all discovered context)
- entities (list all models/entities)
- endpoints (list all API endpoints)
- uiPages (list all UI routes)
- knownIssues (list any issues)

---

## DONE SIGNAL: ${aarDone}

After creating AAR and updating state:
\`\`\`bash
mkdir -p ${AAR_DIR}
echo "DONE - AAR completed at $(date -Iseconds)" > ${aarDone}
\`\`\`

---

## RULES

1. Read ALL code changes for the phase
2. Be thorough in documenting what was built
3. Update state.json with ACCURATE tech context
4. This context SURVIVES compaction - be complete
5. Do NOT start next phase - just document this one

Then STOP.
`.trim();
}
