/**
 * QA Smoke test prompt builder
 * Stack-agnostic: works with web, CLI, mobile, desktop, API
 * Job: DISCOVER project type, install tools, test interactive elements
 */

import { ProjectState } from '../types';
import { QA_DIR } from '../constants';

export function buildQaSmokePrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  // Get current phase info
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const phaseName = phase?.name || `Phase ${phaseNumber}`;
  const deliverables = phase?.deliverables || [];

  // Format deliverables list
  const deliverablesText = deliverables.length > 0
    ? deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'No specific deliverables listed';

  // QA output paths
  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const smokeReport = `${qaDir}/smoke-${attempt}.md`;
  const smokeDone = `${qaDir}/smoke-${attempt}.done`;

  return `
# QA SMOKE TEST - Phase ${phaseNumber} (${phaseName}), Attempt ${attempt}

## PHASE SCOPE — READ THIS FIRST
**Phase ${phaseNumber}: ${phaseName}**

### Deliverables for this phase:
${deliverablesText}

**CRITICAL: Only test features in the deliverables list above.**
Features not listed are planned for FUTURE phases and have NOT been built yet.
Do NOT test or flag missing features that aren't in the deliverables list.

---

## YOUR SINGLE JOB
Test that interactive elements FOR THIS PHASE'S DELIVERABLES respond. Report what's DEAD vs LIVE.

---

## PHASE 1: DISCOVER

First, understand what this project is and how to run it.

### 1.1 Detect Project Type

Check for these files to identify the stack:
\`\`\`bash
ls -la package.json Cargo.toml requirements.txt go.mod build.gradle pom.xml *.csproj 2>/dev/null
cat CLAUDE.md README.md 2>/dev/null | head -50
\`\`\`

### 1.2 Determine Project Type

Based on what you find:
- **Web app** (React, Vue, Angular, etc.) → Use Playwright
- **CLI tool** → Run commands directly
- **API service** → Use curl/httpie
- **Mobile app** (React Native, Flutter) → Use Detox/Maestro
- **Desktop app** (Electron) → Use Playwright
- **Native desktop** → Use OS automation tools

### 1.3 Install Required Tools

**For web apps - Install Playwright:**
\`\`\`bash
npm init playwright@latest --yes 2>/dev/null || npx playwright install chromium
\`\`\`

**For CLI apps - No extra tools needed**

**For APIs - Install httpie if not present:**
\`\`\`bash
which http || pip install httpie 2>/dev/null || brew install httpie 2>/dev/null
\`\`\`

### 1.4 Start the Application

\`\`\`bash
# Find and run the dev command
npm run dev &
# or
npm start &
# or
cargo run &
# or whatever the project uses

# Wait for it to be ready
sleep 5
\`\`\`

**If the app won't start, that's a BLOCKER. Document it and STOP.**

---

## PHASE 2: SMOKE TEST

### For Web Apps (Playwright):

Create and run a smoke test:

\`\`\`typescript
// smoke-test.ts
import { chromium } from 'playwright';

async function smokeTest() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Navigate to app
  await page.goto('http://localhost:3000');

  // Find all interactive elements
  const buttons = await page.locator('button').all();
  const links = await page.locator('a').all();
  const inputs = await page.locator('input, textarea, select').all();

  const results = { dead: [], live: [] };

  // Test each button
  for (const btn of buttons) {
    const text = await btn.textContent();
    const beforeUrl = page.url();
    const beforeContent = await page.content();

    try {
      await btn.click({ timeout: 2000 });
      await page.waitForTimeout(500);

      const afterUrl = page.url();
      const afterContent = await page.content();

      if (beforeUrl === afterUrl && beforeContent === afterContent) {
        results.dead.push(\`Button: "\${text}" - no response\`);
      } else {
        results.live.push(\`Button: "\${text}"\`);
      }
    } catch (e) {
      results.dead.push(\`Button: "\${text}" - error: \${e.message}\`);
    }

    // Reset state
    await page.goto('http://localhost:3000');
  }

  // Similar for links and inputs...

  console.log('DEAD:', results.dead);
  console.log('LIVE:', results.live.length, 'elements working');

  await browser.close();
}

smokeTest();
\`\`\`

Run it:
\`\`\`bash
npx ts-node smoke-test.ts
\`\`\`

### For CLI Apps:

\`\`\`bash
# Test each command
./app --help
./app command1
./app command2 --flag

# DEAD = no output or error
# LIVE = expected behavior
\`\`\`

### For APIs:

\`\`\`bash
# Test each endpoint
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/login -d '{"email":"test@test.com"}'

# DEAD = 500 or no response
# LIVE = correct status + data
\`\`\`

---

## OUTPUT: ${smokeReport}

Create this file:

\`\`\`markdown
# Smoke Test Report - Phase ${phaseNumber}, Attempt ${attempt}

**Date:** [timestamp]
**Project Type:** [web/cli/api/mobile/desktop]
**URL/Command:** [how to access]

## Discovery

- Stack: [detected stack]
- Tools installed: [playwright/none/httpie]
- App started: YES/NO

## Results

### DEAD Elements (do nothing when interacted with)
- [Element]: [location] - [what happened]

### LIVE Elements
- [count] interactive elements working

## Summary

- **Total Elements:** X
- **LIVE:** Y
- **DEAD:** Z
- **Status:** PASS (0 dead) / FAIL (dead elements found)
\`\`\`

---

## DONE SIGNAL: ${smokeDone}

When complete:
\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - Smoke test completed at $(date -Iseconds)" > ${smokeDone}
\`\`\`

---

## RULES

1. **DISCOVER first** - Understand what you're testing
2. **Install tools** - Use appropriate automation for the stack
3. **Test EVERY interactive element** - Buttons, links, inputs, commands
4. **DEAD = no response** - Element does nothing when activated
5. **Be thorough** - This catches obvious breakage
6. **Do NOT fix** - Just report

Then STOP.
`.trim();
}
