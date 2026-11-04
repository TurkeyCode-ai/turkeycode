/**
 * QA Visual test prompt builder
 * Job: Capture screenshots, then a fresh-context agent reviews them blind.
 * The fresh agent has NEVER seen the code - catches what familiar eyes miss.
 *
 * Games skip this file's capture: the orchestrator records frames itself
 * (src/godot-capture.ts) and only the blind review below runs as a session.
 *
 * Two shapes for everything else, decided by the active backend's capabilities:
 * - subagents (Claude Code): ONE session captures and spawns the blind
 *   reviewer via the Task tool (the historical flow).
 * - no subagents (codex/gemini/opencode/custom): the capture session stops
 *   after capturing, and the orchestrator spawns a SECOND session with the
 *   review-only prompt (buildQaVisualReviewPrompt). A new print-mode session
 *   is fresh-context by construction, so blindness is preserved.
 */

import { ProjectState } from '../types';
import { QA_DIR, SCREENSHOTS_DIR, REFERENCE_DIR } from '../constants';
import { AgentCapabilities, CLAUDE_BACKEND } from '../agents';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { oneTurnRule } from './one-turn';

const GODOT_REVIEW_CATEGORIES = `These are frames from a running game, a few seconds apart. Review EVERY frame for:
- **BLOCKERS**: Blank, black or solid-color frames where gameplay should be, missing sprites or magenta placeholder textures, unreadable HUD or text, UI cut off by the window, frames that never change when the deliverable involves motion, anything that makes a deliverable look absent or broken.
- **WARNINGS**: Inconsistent art style, weak contrast between the player and the background, cramped or misaligned HUD, subjective polish problems.

`;

/** Everything both prompt shapes need, derived once. */
function visualContext(state: ProjectState, phaseNumber: number, attempt: number) {
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

  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const screenshotsDir = `${SCREENSHOTS_DIR}/phase-${phaseNumber}`;

  // Named one by one when capture already ran, so "review them all" is checkable.
  const capturedFiles = existsSync(screenshotsDir)
    ? readdirSync(screenshotsDir).filter(f => /\.(png|jpe?g|txt|json)$/i.test(f)).sort()
    : [];

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

  return {
    phaseName, specContext, referenceImages, qaDir, screenshotsDir, capturedFiles,
    deliverablesText, previousVisualContext,
    isGame: state.projectType === 'game-godot',
    visualReport: `${qaDir}/visual-${attempt}.md`,
    visualJson: `${qaDir}/visual-${attempt}.json`,
    visualDone: `${qaDir}/visual-${attempt}.done`,
  };
}

/**
 * The blind-review instructions — what the fresh-context reviewer is told,
 * whether it runs as a Task-tool subagent or as its own session.
 */
function blindReviewBody(
  ctx: ReturnType<typeof visualContext>,
  phaseNumber: number,
  appDescription: string
): string {
  const { screenshotsDir, capturedFiles, referenceImages, specContext, deliverablesText, previousVisualContext } = ctx;
  return `
You are a visual QA reviewer doing a BLIND review. You have NEVER seen the code.

APP DESCRIPTION:
${appDescription}

SCREENSHOTS TO REVIEW:
${capturedFiles.length > 0 ? capturedFiles.map(f => `${screenshotsDir}/${f}`).join('\n') : `${screenshotsDir}/*.png`}

OPEN EVERY FILE LISTED, not a sample. You cannot say something is missing from a
file you did not open. List every file you opened in framesReviewed in the JSON.

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
${ctx.isGame ? GODOT_REVIEW_CATEGORIES : `- **BLOCKERS**: Dead/broken elements, missing required UI, broken layouts, text overflow, unreadable content, broken images, elements that prevent usability, **low contrast text** (light text on light backgrounds, gray text on white, any text that is hard to read)
- **AI-generated / template look (BLOCKER)**: the app must look hand-crafted, not AI-generated. Flag any of these CONCRETE tells as blockers (they are required design rules, not subjective preferences): visible gradients (backgrounds, buttons, or text); the default purple/indigo/violet "AI" palette; emojis used as icons, bullets, or in headings; a centered-everything layout (centered hero plus a centered three-card feature grid); or a generic untouched default-Tailwind starter look with no intentional design system.
- **No point of view (BLOCKER)**: the app should look like a real product, not a bare list. Worst cases are blockers: NO real logo/wordmark in the header (just the app name in a default font); a totally generic, voiceless layout with no visual identity. (Motion can't be judged from a still screenshot - leave that to functional QA.) Do NOT block on subjective taste; that's a warning.
- **WARNINGS**: Wrong colors vs spec, wrong fonts vs spec, significant alignment issues, significant responsive breakage, subjective design/polish preferences

`}Do NOT flag as issues:
- Subjective design preferences ("I would have made the button bigger")
- Minor spacing differences between desktop and mobile
- Subtle color variations not specified in the spec
- Things that "could be better" but aren't broken

If something a deliverable needs never appears in any file, mark it kind "not-shown"
in the JSON. That records that these captures did not show it, not that it is broken.

Be thorough but fair. Flag real problems, not nitpicks. For each issue include:
- Which screenshot
- What's wrong (specific)
- Severity: BLOCKER (breaks usability or violates spec) or WARNING (cosmetic polish)

Format your response as:

BLOCKERS:
1. [screenshot] - [issue]

WARNINGS:
1. [screenshot] - [issue]
`.trim();
}

/** The report + JSON + done-file output contract, shared by both shapes. */
function reviewOutputSections(
  ctx: ReturnType<typeof visualContext>,
  phaseNumber: number,
  attempt: number,
  leadIn: string
): string {
  const { qaDir, visualReport, visualJson, visualDone } = ctx;
  return `
## OUTPUT: ${visualReport}

${leadIn}

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

## MACHINE-READABLE OUTPUT: ${visualJson}

ALSO write a JSON file so the orchestrator can fold these findings into the phase
verdict. Every blocker here counts toward the QA gate exactly like a functional
blocker — so be precise and do not invent nitpicks.

\`\`\`json
{
  "framesReviewed": ["every file you opened"],
  "blockers": [
    { "type": "visual", "kind": "seen", "description": "[screenshot] what's broken", "location": "route/viewport", "severity": "critical" }
  ],
  "warnings": [
    { "type": "visual", "description": "[screenshot] cosmetic issue", "location": "route/viewport" }
  ]
}
\`\`\`

Use kind "seen" for a problem visible in a file and "not-shown" for something absent from all of them.
If there are zero blockers and zero warnings, still list framesReviewed, with empty blockers and warnings.
The \`description\` and \`location\` MUST mirror what you wrote in the markdown report.

---

## DONE SIGNAL: ${visualDone}

When complete (both ${visualReport} AND ${visualJson} written):
\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - Visual test completed at $(date -Iseconds)" > ${visualDone}
\`\`\`
`.trim();
}

export function buildQaVisualPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number,
  caps: AgentCapabilities = CLAUDE_BACKEND.capabilities
): string {
  const ctx = visualContext(state, phaseNumber, attempt);
  const { phaseName, qaDir, screenshotsDir, deliverablesText } = ctx;
  const captureDone = `${qaDir}/capture-${attempt}.done`;
  const stepTwo = caps.subagents
    ? '2. Then spawn a FRESH AGENT to review them blind (no code access)'
    : '2. Then write the capture manifest and stop — a separate fresh session reviews them blind';

  // Phase 2 + output contract differ by capability: with subagents the same
  // session spawns the blind reviewer and writes the report; without, this
  // session STOPS after capture and a separate fresh session reviews.
  const reviewSection = caps.subagents
    ? `
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
${blindReviewBody(ctx, phaseNumber, '[One paragraph about what this app does - from CLAUDE.md or project description]')}
\`\`\`

---

${reviewOutputSections(ctx, phaseNumber, attempt, 'After getting the review agent\'s response, create this file:')}
`.trim()
    : `
## PHASE 2: STOP — A SEPARATE FRESH SESSION REVIEWS

Do NOT review the screenshots yourself. The agent that captured the app cannot
objectively evaluate its visual quality — a separate session that has never
seen the code will do the blind review after you finish.

Your only remaining job is the capture manifest and the done signal:

1. Write ${qaDir}/capture-${attempt}.md listing every file you captured:
   \`\`\`markdown
   # Screenshot Capture - Phase ${phaseNumber}, Attempt ${attempt}

   | File | Route | Viewport |
   |------|-------|----------|
   | home-desktop.png | / | 1280x800 |
   [list all captured files]
   \`\`\`

2. Write the done signal:
   \`\`\`bash
   mkdir -p ${qaDir}
   echo "DONE - Capture completed at $(date -Iseconds)" > ${captureDone}
   \`\`\`
`.trim();

  const rules = caps.subagents
    ? `
## RULES

1. **Capture FULL PAGE** - Use fullPage: true, can't QA what you can't see
2. **Both viewports** - Desktop (1280x800) AND mobile (375x667)
3. **FRESH AGENT for review** - You cannot review your own work objectively
4. **Be thorough but fair** - Flag real problems, not subjective preferences
5. **Spec violations are blockers** - If it contradicts the spec, it's wrong
6. **Do NOT fix** - Just report
7. **BLOCKER = broken/unusable** - Dead elements, missing required UI, broken layouts
8. **WARNING = cosmetic polish** - Wrong colors, minor alignment, subtle responsive issues

${oneTurnRule('the visual report and its JSON')}

Then STOP.
`.trim()
    : `
## RULES

1. **Capture FULL PAGE** - Use fullPage: true, can't QA what you can't see
2. **Both viewports** - Desktop (1280x800) AND mobile (375x667)
3. **Do NOT review** - A separate fresh session judges the screenshots
4. **Do NOT fix** - Just capture

${oneTurnRule(captureDone)}

Then STOP.
`.trim();

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
${stepTwo}

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
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });

  for (const route of routes) {
    // Desktop (1280x800)
    const desktopPage = await browser.newPage({
      viewport: { width: 1280, height: 800 }
    });
    await desktopPage.goto(\`http://localhost:5123\${route.path}\`);
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
    await mobilePage.goto(\`http://localhost:5123\${route.path}\`);
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
curl -s http://localhost:5123/api/health | jq > ${screenshotsDir}/health.json
curl -s http://localhost:5123/api/users | jq > ${screenshotsDir}/users.json
\`\`\`

---

${reviewSection}

---

${rules}
`.trim();
}

/**
 * Standalone blind-review session prompt, for backends without in-session
 * subagents. Spawned by the orchestrator AFTER the capture session finishes;
 * being a new session, it has never seen the code — the blindness the whole
 * flow exists for.
 */
export function buildQaVisualReviewPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number,
  caps: AgentCapabilities = CLAUDE_BACKEND.capabilities
): string {
  const ctx = visualContext(state, phaseNumber, attempt);
  const appDescription = state.projectDescription || '(no description recorded)';

  const noVisionNote = caps.multimodalImages ? '' : `

NOTE: If you cannot view image files, do a structural review instead: verify the
screenshots exist and are non-trivial (file sizes, dimensions via available
tools), review any .txt/.json captures as text, and state clearly in the report
that screenshot judgment was unavailable on this backend. Do NOT invent visual
findings you could not see.`;

  return `
# QA VISUAL REVIEW (BLIND) - Phase ${phaseNumber}, Attempt ${attempt}

${blindReviewBody(ctx, phaseNumber, appDescription)}

Do NOT open, read, or search the project's source code — you are reviewing the
rendered product only. Read ONLY the screenshot files (and reference images/
capture manifest under ${ctx.qaDir}).${noVisionNote}

---

${reviewOutputSections(ctx, phaseNumber, attempt, 'After completing your review, create this file:')}

---

## RULES

1. **Be thorough but fair** - Flag real problems, not subjective preferences
2. **Spec violations are blockers** - If it contradicts the spec, it's wrong
3. **Do NOT fix** - Just report
4. **BLOCKER = broken/unusable** - Dead elements, missing required UI, broken layouts
5. **WARNING = cosmetic polish** - Wrong colors, minor alignment, subtle responsive issues

${oneTurnRule('the visual report and its JSON')}

Then STOP.
`.trim();
}
