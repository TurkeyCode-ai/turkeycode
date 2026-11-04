/**
 * QA Visual test prompt builder
 * Job: Capture screenshots, then spawn fresh-context agent for blind review
 * The fresh agent has NEVER seen the code - catches what familiar eyes miss
 */

import { GODOT_DIR_SHELL } from '../detect-project-type';
import { oneTurnRule } from './one-turn';
import { ProjectState } from '../types';
import { QA_DIR, SCREENSHOTS_DIR, REFERENCE_DIR } from '../constants';
import { existsSync, readdirSync, readFileSync } from 'fs';

/**
 * A game has no URL, so the web capture flow would point Playwright at a port
 * nothing listens on and review an error page. Frames come from the engine.
 * Measured on Godot 4.7: `--write-movie <name>.png` writes a PNG per frame when
 * windowed, and crashes under --headless.
 */
function godotCapture(screenshotsDir: string): string {
  return `## YOUR SINGLE JOB
1. Render real frames from the game
2. Then spawn a FRESH AGENT to review them blind (no code access)

---

## PHASE 1: CAPTURE FRAMES

Do NOT use Playwright or open a URL. Nothing is listening on a port. This must
run WINDOWED: --headless has no renderer and crashes on --write-movie.

\`\`\`bash
${GODOT_DIR_SHELL}
FRAMES="$PWD/${screenshotsDir}"
mkdir -p "$FRAMES"

# Linux CI has no display, so give Godot one. Desktops need nothing.
GODOT_RUN=""
if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ]; then GODOT_RUN="xvfb-run -a"; fi

timeout 180 $GODOT_RUN godot --path "$GODOT_DIR" --write-movie "$FRAMES/frame.png" --fixed-fps 10 --quit-after 300 2>&1 | tail -20 || true

# 30 seconds at 10fps is 300 frames. Keep one every 3 seconds for the reviewer.
rm -f "$FRAMES/frame.wav"
ls "$FRAMES"/frame*.png | awk 'NR % 30 != 1' | xargs rm -f
ls -la "$FRAMES"
\`\`\`

That records the main scene. If a deliverable lives on another scene, record it
too by passing the scene and a different name, for example
\`godot --path "$GODOT_DIR" res://levels/boss.tscn --write-movie "$FRAMES/boss.png" ...\`,
then thin those frames the same way.

If no PNG frames exist, that is a BLOCKER: report that the game produced no
frames, and include the command output.

`;
}

const GODOT_REVIEW_CATEGORIES = `These are frames from a running game, a few seconds apart. Review EVERY frame for:
- **BLOCKERS**: Blank, black or solid-color frames where gameplay should be, missing sprites or magenta placeholder textures, unreadable HUD or text, UI cut off by the window, frames that never change when the deliverable involves motion, anything that makes a deliverable look absent or broken.
- **WARNINGS**: Inconsistent art style, weak contrast between the player and the background, cramped or misaligned HUD, subjective polish problems.

`;

const GODOT_CAPTURE_RULES = `1. **Real frames only** - Windowed capture, never --headless
2. **Cover every deliverable** - Record each scene a deliverable lives on
`;

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

  const isGame = state.projectType === 'game-godot';

  // QA output paths
  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const screenshotsDir = `${SCREENSHOTS_DIR}/phase-${phaseNumber}`;
  const visualReport = `${qaDir}/visual-${attempt}.md`;
  const visualJson = `${qaDir}/visual-${attempt}.json`;
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

${isGame ? godotCapture(screenshotsDir) : `## YOUR SINGLE JOB
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

`}---

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
${isGame ? GODOT_REVIEW_CATEGORIES : `- **BLOCKERS**: Dead/broken elements, missing required UI, broken layouts, text overflow, unreadable content, broken images, elements that prevent usability, **low contrast text** (light text on light backgrounds, gray text on white, any text that is hard to read)
- **AI-generated / template look (BLOCKER)**: the app must look hand-crafted, not AI-generated. Flag any of these CONCRETE tells as blockers (they are required design rules, not subjective preferences): visible gradients (backgrounds, buttons, or text); the default purple/indigo/violet "AI" palette; emojis used as icons, bullets, or in headings; a centered-everything layout (centered hero plus a centered three-card feature grid); or a generic untouched default-Tailwind starter look with no intentional design system.
- **No point of view (BLOCKER)**: the app should look like a real product, not a bare list. Worst cases are blockers: NO real logo/wordmark in the header (just the app name in a default font); a totally generic, voiceless layout with no visual identity. (Motion can't be judged from a still screenshot - leave that to functional QA.) Do NOT block on subjective taste; that's a warning.
- **WARNINGS**: Wrong colors vs spec, wrong fonts vs spec, significant alignment issues, significant responsive breakage, subjective design/polish preferences

`}Do NOT flag as issues:
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

## MACHINE-READABLE OUTPUT: ${visualJson}

ALSO write a JSON file so the orchestrator can fold these findings into the phase
verdict. Every blocker here counts toward the QA gate exactly like a functional
blocker — so be precise and do not invent nitpicks.

\`\`\`json
{
  "blockers": [
    { "type": "visual", "description": "[screenshot] what's broken", "location": "route/viewport", "severity": "critical" }
  ],
  "warnings": [
    { "type": "visual", "description": "[screenshot] cosmetic issue", "location": "route/viewport" }
  ]
}
\`\`\`

If there are zero blockers and zero warnings, write \`{ "blockers": [], "warnings": [] }\`.
The \`description\` and \`location\` MUST mirror what you wrote in the markdown report.

---

## DONE SIGNAL: ${visualDone}

When complete (both ${visualReport} AND ${visualJson} written):
\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - Visual test completed at $(date -Iseconds)" > ${visualDone}
\`\`\`

---

## RULES

${isGame ? GODOT_CAPTURE_RULES : `1. **Capture FULL PAGE** - Use fullPage: true, can't QA what you can't see
2. **Both viewports** - Desktop (1280x800) AND mobile (375x667)
`}3. **FRESH AGENT for review** - You cannot review your own work objectively
4. **Be thorough but fair** - Flag real problems, not subjective preferences
5. **Spec violations are blockers** - If it contradicts the spec, it's wrong
6. **Do NOT fix** - Just report
7. **BLOCKER = broken/unusable** - Dead elements, missing required UI, broken layouts
8. **WARNING = cosmetic polish** - Wrong colors, minor alignment, subtle responsive issues

${oneTurnRule('the visual report and its JSON')}

Then STOP.
`.trim();
}
