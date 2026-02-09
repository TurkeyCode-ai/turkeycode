/**
 * QA Visual test prompt builder
 * Job: Capture screenshots, then spawn fresh-context agent for blind review
 * The fresh agent has NEVER seen the code - catches what familiar eyes miss
 */

import { ProjectState } from '../types';
import { QA_DIR, SCREENSHOTS_DIR, REFERENCE_DIR } from '../constants';
import { existsSync, readdirSync, readFileSync } from 'fs';

export function buildQaVisualPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  // Look up current phase for scoping
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const deliverables = phase?.deliverables || [];
  const specContext = phase?.specContext || '';

  // List reference images if any
  let referenceImages: string[] = [];
  if (existsSync(REFERENCE_DIR)) {
    referenceImages = readdirSync(REFERENCE_DIR)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'));
  }

  // QA output paths
  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const screenshotsDir = `${SCREENSHOTS_DIR}/phase-${phaseNumber}`;
  const visualReport = `${qaDir}/visual-${attempt}.md`;
  const visualDone = `${qaDir}/visual-${attempt}.done`;

  // Format deliverables list
  const deliverablesText = deliverables.length > 0
    ? deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'No specific deliverables listed';

  // Load previous visual report for attempt > 1 so reviewer verifies fixes
  let previousVisualContext = '';
  if (attempt > 1) {
    const prevVisualPath = `${qaDir}/visual-${attempt - 1}.md`;
    if (existsSync(prevVisualPath)) {
      const prevReport = readFileSync(prevVisualPath, 'utf-8');
      const truncated = prevReport.length > 4000 ? prevReport.slice(0, 4000) + '\n\n... (truncated)' : prevReport;
      previousVisualContext = `
PREVIOUS VISUAL REPORT (Attempt ${attempt - 1}) — issues that were flagged and should now be fixed:
\`\`\`markdown
${truncated}
\`\`\`

YOUR PRIORITY ORDER:
1. **VERIFY FIXES**: Check each issue from the previous report above. Are they fixed? Note which are resolved vs still present.
2. **Flag persistent issues**: If something from the previous report is NOT fixed, flag it again.
3. **Flag genuine new issues ONLY if significant**: Only flag NEW issues that are clearly broken, ugly, or violate the spec. Do NOT invent new cosmetic nitpicks just because you're looking with fresh eyes. Minor spacing differences, subtle color variations, and "I would have done it differently" opinions are NOT issues.
`;
    }
  }

  return `
# QA VISUAL TEST - Phase ${phaseNumber} (${phaseName}), Attempt ${attempt}

## PHASE SCOPE — READ THIS FIRST
**Phase ${phaseNumber}: ${phaseName}**

### Deliverables for this phase:
${deliverablesText}

**CRITICAL: ONLY evaluate visuals for Phase ${phaseNumber} deliverables listed above.**
Features not listed are planned for FUTURE phases and have NOT been built yet.
Do NOT flag missing features that aren't in the deliverables list.

---

## YOUR SINGLE JOB
1. Capture full-page screenshots at desktop AND mobile sizes
2. Then spawn a FRESH AGENT to review them blind (no code access)

---

## PHASE 1: CAPTURE SCREENSHOTS

### Install Playwright (if not done in smoke test):
\`\`\`bash
npx playwright install chromium 2>/dev/null || true
\`\`\`

### Create Screenshot Script:

\`\`\`typescript
// capture-screenshots.ts
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const screenshotDir = '${screenshotsDir}';
mkdirSync(screenshotDir, { recursive: true });

// Routes to capture (adjust based on what the app has)
const routes = [
  { name: 'home', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'dashboard', path: '/dashboard' },
  // Add more based on what was built this phase
];

async function capture() {
  const browser = await chromium.launch();

  for (const route of routes) {
    // Desktop (1280x800)
    const desktopPage = await browser.newPage({
      viewport: { width: 1280, height: 800 }
    });
    await desktopPage.goto(\`http://localhost:3000\${route.path}\`);
    await desktopPage.waitForTimeout(1000); // Let animations settle
    await desktopPage.screenshot({
      path: \`\${screenshotDir}/\${route.name}-desktop.png\`,
      fullPage: true
    });
    await desktopPage.close();

    // Mobile (375x667)
    const mobilePage = await browser.newPage({
      viewport: { width: 375, height: 667 }
    });
    await mobilePage.goto(\`http://localhost:3000\${route.path}\`);
    await mobilePage.waitForTimeout(1000);
    await mobilePage.screenshot({
      path: \`\${screenshotDir}/\${route.name}-mobile.png\`,
      fullPage: true
    });
    await mobilePage.close();
  }

  await browser.close();
  console.log('Screenshots saved to ${screenshotsDir}');
}

capture();
\`\`\`

### Run It:
\`\`\`bash
npx ts-node capture-screenshots.ts
ls -la ${screenshotsDir}
\`\`\`

### For CLI Apps:
\`\`\`bash
mkdir -p ${screenshotsDir}
# Capture terminal output
./app --help > ${screenshotsDir}/help.txt
./app list > ${screenshotsDir}/list.txt
\`\`\`

### For APIs:
\`\`\`bash
mkdir -p ${screenshotsDir}
# Document response formats
curl -s http://localhost:3000/api/health | jq > ${screenshotsDir}/health.json
curl -s http://localhost:3000/api/users | jq > ${screenshotsDir}/users.json
\`\`\`

---

## PHASE 2: FRESH-CONTEXT REVIEW

**CRITICAL: This MUST be done by a NEW agent that has NEVER seen the code.**

Why? The agent that built the app cannot objectively evaluate its visual quality.
Fresh eyes catch what familiar eyes miss.

### Spawn the Review Agent:

Use the Task tool with subagent_type="general-purpose" and provide:
1. One paragraph describing what the app does
2. The captured screenshots (by file path)
3. Reference specs/images if they exist
4. NO code, NO implementation details

### Review Prompt to Send:

\`\`\`
You are a visual QA reviewer doing a BLIND review. You have NEVER seen the code.

APP DESCRIPTION:
[One paragraph about what this app does - from CLAUDE.md or project description]

SCREENSHOTS TO REVIEW:
${screenshotsDir}/*.png

${referenceImages.length > 0 ? `
REFERENCE IMAGES FOR COMPARISON:
${referenceImages.map(f => `${REFERENCE_DIR}/${f}`).join('\n')}
` : ''}

${specContext ? `
VISUAL SPECS (Phase ${phaseNumber} only):
${specContext}
` : ''}

PHASE ${phaseNumber} DELIVERABLES (only evaluate these):
${deliverablesText}

IMPORTANT: ONLY flag visual issues for the deliverables listed above.
If you see placeholder content or missing features NOT in the deliverables list,
those are planned for future phases — do NOT report them as issues.
${previousVisualContext}
Review EVERY screenshot for these categories of issues:
- **BLOCKERS**: Dead/broken elements, missing required UI, broken layouts, text overflow, unreadable content, broken images, elements that prevent usability
- **WARNINGS**: Wrong colors vs spec, wrong fonts vs spec, significant alignment issues, significant responsive breakage

Do NOT flag as issues:
- Subjective design preferences ("I would have made the button bigger")
- Minor spacing differences between desktop and mobile
- Subtle color variations not specified in the spec
- Things that "could be better" but aren't broken

Be thorough but fair. Flag real problems, not nitpicks. For each issue include:
- Which screenshot
- What's wrong (specific)
- Severity: BLOCKER (breaks usability or violates spec) or WARNING (cosmetic polish)

Format your response as:

BLOCKERS:
1. [screenshot] - [issue]

WARNINGS:
1. [screenshot] - [issue]
\`\`\`

---

## OUTPUT: ${visualReport}

After getting the review agent's response, create this file:

\`\`\`markdown
# Visual Review - Phase ${phaseNumber}, Attempt ${attempt}

**Date:** [timestamp]
**Screenshots Captured:** [count]
**Reviewed By:** Fresh-context agent (no code access)

## Screenshots Captured

| File | Route | Viewport |
|------|-------|----------|
| home-desktop.png | / | 1280x800 |
| home-mobile.png | / | 375x667 |
[list all captured files]

## Visual Issues

### BLOCKERS (break usability - must fix)
[Copy from review agent response]

### WARNINGS (cosmetic - should fix)
[Copy from review agent response]

## Summary

- **BLOCKERS:** [count]
- **WARNINGS:** [count]
- **Status:** PASS (0 blockers) / FAIL (has blockers)
\`\`\`

---

## DONE SIGNAL: ${visualDone}

When complete:
\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - Visual test completed at $(date -Iseconds)" > ${visualDone}
\`\`\`

---

## RULES

1. **Capture FULL PAGE** - Use fullPage: true, can't QA what you can't see
2. **Both viewports** - Desktop (1280x800) AND mobile (375x667)
3. **FRESH AGENT for review** - You cannot review your own work objectively
4. **Be thorough but fair** - Flag real problems, not subjective preferences
5. **Spec violations are blockers** - If it contradicts the spec, it's wrong
6. **Do NOT fix** - Just report
7. **BLOCKER = broken/unusable** - Dead elements, missing required UI, broken layouts
8. **WARNING = cosmetic polish** - Wrong colors, minor alignment, subtle responsive issues

Then STOP.
`.trim();
}
