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

### 1.4 Database Setup

**Before starting the app, ensure the database is ready.** Many apps will crash or return empty data without this.

\`\`\`bash
# For Prisma projects (check for prisma/schema.prisma)
if [ -f prisma/schema.prisma ]; then
  # Push schema to test database (creates tables if missing)
  npx prisma db push --skip-generate 2>/dev/null || npx prisma migrate deploy 2>/dev/null
  # Generate client if needed
  npx prisma generate 2>/dev/null
  # Run seed if available
  npx prisma db seed 2>/dev/null || true
fi

# For Drizzle projects
if [ -f drizzle.config.ts ] || [ -f drizzle.config.js ]; then
  npx drizzle-kit push 2>/dev/null || true
fi

# For Knex/other migration tools
if [ -f knexfile.js ] || [ -f knexfile.ts ]; then
  npx knex migrate:latest 2>/dev/null || true
fi

# For Django projects
if [ -f manage.py ]; then
  python manage.py migrate 2>/dev/null || true
fi
\`\`\`

**If the database won't set up, that's a BLOCKER. Document it.**

### 1.5 Start the Application

**IMPORTANT: Always kill and restart the dev server.** Previous fix attempts may have left the server with stale build cache (missing chunks, broken hot reload). A fresh start is cheap insurance.

**CRITICAL: Use port 5123 for all QA testing** — port 3000 is reserved by the platform. Set PORT=5123 when starting the app.

\`\`\`bash
# Kill any existing dev server first
pkill -f "next dev" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "webpack-dev-server" 2>/dev/null || true
sleep 2

# For Next.js: clear build cache to prevent stale vendor-chunks
rm -rf .next 2>/dev/null || true

# ALWAYS use port 5123 to avoid conflicting with the platform on port 3000
PORT=5123 npm run dev &
# or
PORT=5123 npm start &
# or
cargo run &
# or whatever the project uses

# Wait for it to be ready (longer after cache clear)
sleep 10
\`\`\`

**Use http://localhost:5123 for ALL test URLs** — never use port 3000.

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
  await page.goto('http://localhost:4000');

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
    await page.goto('http://localhost:4000');
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
curl -s http://localhost:4000/api/health
curl -s http://localhost:4000/api/users
curl -X POST http://localhost:4000/api/login -d '{"email":"test@test.com"}'

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
