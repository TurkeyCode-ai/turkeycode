/**
 * Combined QA prompt — smoke + functional + verdict in ONE session.
 * v3-fast: Replaces the 4-agent QA carousel (smoke → functional → visual → verdict)
 * with a single comprehensive session.
 */

import { ProjectState } from '../types';
import { QA_DIR, SPECS_FILE } from '../constants';
import { readFileSync, existsSync } from 'fs';

export function buildQaCombinedPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const deliverables = phase?.deliverables || [];
  const acceptanceCriteria = phase?.acceptanceCriteria || [];

  const deliverablesText = deliverables.length > 0
    ? deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'No specific deliverables listed';

  const acText = acceptanceCriteria.length > 0
    ? acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
    : 'No specific acceptance criteria listed';

  // Load specs for expected behavior
  let specsContent = '';
  if (existsSync(SPECS_FILE)) {
    specsContent = readFileSync(SPECS_FILE, 'utf-8');
  }
  const flowMatches = specsContent.match(/Flow \d+:.*$/gm) || [];
  const flows = flowMatches.length > 0
    ? flowMatches.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : 'No explicit flows - test based on acceptance criteria';

  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const verdictPath = `${qaDir}/verdict-${attempt}.json`;
  const verdictDone = `${qaDir}/verdict-${attempt}.done`;

  // Load previous verdict for context on retry
  let previousContext = '';
  if (attempt > 1) {
    const prevVerdictPath = `${qaDir}/verdict-${attempt - 1}.json`;
    if (existsSync(prevVerdictPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevVerdictPath, 'utf-8'));
        const prevBlockers = prev.blockers || [];
        previousContext = `
---

## PREVIOUS QA ROUND (Attempt ${attempt - 1})

Found ${prevBlockers.length} blockers:
${prevBlockers.map((b: { description: string; location: string }) => `- ${b.description} (${b.location})`).join('\n') || 'None'}

Fixes were attempted. Check if these are NOW resolved.
`;
      } catch { /* ignore */ }
    }
  }

  return `
# QA TEST — Phase ${phaseNumber} (${phaseName}), Attempt ${attempt}

## PHASE SCOPE — READ THIS FIRST
**Phase ${phaseNumber}: ${phaseName}**

### Deliverables:
${deliverablesText}

### Acceptance Criteria:
${acText}

**CRITICAL: Only test features in the deliverables list above.**
Features not listed are planned for FUTURE phases — do NOT test or flag them.
${previousContext}
---

## YOUR JOB

Run a complete QA pass in this single session:
1. **Setup** — Start the app, ensure database is ready
2. **Smoke test** — Check all interactive elements respond
3. **Functional test** — Verify features produce correct output
4. **Write verdict** — CLEAN or NEEDS_FIX with blockers/warnings JSON

---

## STEP 1: SETUP

### Database
\`\`\`bash
if [ -f prisma/schema.prisma ]; then
  npx prisma db push --skip-generate 2>/dev/null || npx prisma migrate deploy 2>/dev/null
  npx prisma generate 2>/dev/null
  npx prisma db seed 2>/dev/null || true
fi
\`\`\`

### Start the app
**CRITICAL: Use port 5123** — port 3000 is reserved by the platform.
\`\`\`bash
pkill -f "next dev" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 2
rm -rf .next 2>/dev/null || true
PORT=5123 npm run dev &
sleep 10
\`\`\`

**If the app won't start, that's a BLOCKER. Write verdict and stop.**

---

## STEP 2: SMOKE TEST

Test every interactive element FOR THIS PHASE'S DELIVERABLES:

For web apps, use Playwright:
\`\`\`bash
npx playwright install chromium 2>/dev/null
\`\`\`

Test all buttons, links, inputs, forms. For each:
- **DEAD** = no response when clicked/submitted
- **LIVE** = something happens (page change, modal, toast, data update)

---

## STEP 3: FUNCTIONAL TEST

For each deliverable and acceptance criterion, verify correct OUTPUT:
- INPUT → ACTION → VERIFY OUTPUT
- Don't just check "it responds" — check "it does the RIGHT THING"
- Verify data persistence (reload after save, check it's still there)
- Test core flows from specs:

${flows}

### Security checks (if app has user accounts):
- Auth guards on mutating routes (should 401 without login)
- Input sanitization (try \`<script>alert('xss')</script>\` in text fields)

---

## STEP 4: WRITE VERDICT

### Classify findings:
- **BLOCKER**: Dead elements, failed acceptance criteria, crashes, broken flows, missing required deliverables, placeholder "coming soon" pages
- **WARNING**: Minor alignment, subtle color differences, font inconsistencies, UX suggestions
- **OUT-OF-SCOPE**: Features not in this phase's deliverables — ignore these

### CLEAN = ZERO blockers (warnings OK)
### NEEDS_FIX = ANY blocker exists

---

## OUTPUT: ${verdictPath}

Write this JSON file:

\`\`\`json
{
  "verdict": "CLEAN or NEEDS_FIX",
  "timestamp": "ISO timestamp",
  "phase": ${phaseNumber},
  "attempt": ${attempt},
  "summary": {
    "smoke": { "passed": true, "deadElements": 0 },
    "functional": { "passed": true, "flowsPassed": 0, "flowsFailed": 0 }
  },
  "blockers": [
    { "type": "smoke|functional", "description": "what's broken", "location": "where", "severity": "critical" }
  ],
  "warnings": [
    { "type": "visual|functional", "description": "cosmetic issue", "location": "where" }
  ],
  "filteredOutOfScope": [
    { "type": "smoke", "description": "what was found", "reason": "why it's out of scope" }
  ],
  "notes": "summary"
}
\`\`\`

---

## DONE SIGNAL: ${verdictDone}

\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - QA completed at $(date -Iseconds)" > ${verdictDone}
\`\`\`

---

## RULES

1. **Deliverables only** — skip findings about future-phase features
2. **Test everything in scope** — every deliverable, every acceptance criterion
3. **Verify output, not just response** — a button that does the wrong thing is broken
4. **Blockers = broken functionality, warnings = cosmetic polish**
5. **Do NOT fix anything** — just test and report
6. **Write valid JSON** — the verdict file must parse correctly
7. **NEVER paste terminal output into source files** — if you create test scripts, write clean code only

Then STOP.
`.trim();
}
