/**
 * QA Functional test prompt builder
 * Tests that features produce CORRECT OUTPUT, not just that they respond
 * SMOKE finds "does it respond?" - FUNCTIONAL finds "does it work correctly?"
 */

import { ProjectState } from '../types';
import { QA_DIR, SPECS_FILE } from '../constants';
import { readFileSync, existsSync } from 'fs';

export function buildQaFunctionalPrompt(
  state: ProjectState,
  phaseNumber: number,
  attempt: number
): string {
  // Load specs for expected behavior
  let specsContent = '';
  if (existsSync(SPECS_FILE)) {
    specsContent = readFileSync(SPECS_FILE, 'utf-8');
  }

  // Extract flows from specs
  const flowMatches = specsContent.match(/Flow \d+:.*$/gm) || [];
  const flows = flowMatches.length > 0
    ? flowMatches.map((f, i) => `${i + 1}. ${f}`).join('\n')
    : 'No explicit flows - test based on acceptance criteria';

  // Get acceptance criteria from current build phase
  const phase = state.buildPhases.find(p => p.number === phaseNumber);
  const allCriteria = phase
    ? phase.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`)
    : [];

  // QA output paths
  const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
  const functionalReport = `${qaDir}/functional-${attempt}.md`;
  const functionalDone = `${qaDir}/functional-${attempt}.done`;

  return `
# QA FUNCTIONAL TEST - Phase ${phaseNumber}, Attempt ${attempt}

## YOUR SINGLE JOB
Verify that features produce the CORRECT OUTPUT. This is NOT visual testing - this is logic testing.

---

## WHY THIS MATTERS

SMOKE test asks: "Does the button respond?"
FUNCTIONAL test asks: "Does the button do the RIGHT THING?"

A calculator "+" button that opens a menu = SMOKE pass, FUNCTIONAL fail.
A save button that shows a toast but doesn't save = SMOKE pass, FUNCTIONAL fail.
A graph that renders empty instead of data = SMOKE pass, FUNCTIONAL fail.

**These bugs are INVISIBLE to visual QA. You MUST test functionally.**

---

## CORE FLOWS TO TEST

### From Specs:
${flows}

### From Acceptance Criteria:
${allCriteria.join('\n')}

---

## FUNCTIONAL TEST PROCEDURE

For EACH core flow:

### Pattern: INPUT → ACTION → VERIFY OUTPUT

\`\`\`
1. SET UP: Prepare test data/state
2. INPUT: Perform the action (click, type, call API)
3. EXPECTED: What SHOULD happen (from spec)
4. ACTUAL: Read the REAL output (not visual, actual data)
5. RESULT: PASS if actual === expected, FAIL otherwise
\`\`\`

---

## HOW TO VERIFY OUTPUT (by stack)

### Web Apps (Playwright):

\`\`\`typescript
// Don't just check if button clicked - verify the RESULT
import { chromium } from 'playwright';

async function functionalTest() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');

  // Example: Test a calculator
  await page.fill('#input-a', '2');
  await page.fill('#input-b', '3');
  await page.click('#add-button');

  // READ THE ACTUAL OUTPUT
  const result = await page.locator('#result').textContent();
  const expected = '5';

  console.log(\`Expected: \${expected}, Actual: \${result}\`);
  console.log(result === expected ? 'PASS' : 'FAIL');

  // Example: Test a form that saves
  await page.fill('#name', 'Test User');
  await page.click('#save-button');

  // Verify it ACTUALLY saved (not just showed a toast)
  await page.reload();
  const savedName = await page.locator('#name').inputValue();
  console.log(savedName === 'Test User' ? 'PASS - Data persisted' : 'FAIL - Data not saved');

  await browser.close();
}
\`\`\`

### CLI Apps:

\`\`\`bash
# Test with KNOWN INPUT and verify EXPECTED OUTPUT
echo "hello" | ./app --uppercase
# Expected: "HELLO"
# Actual: [captured stdout]
# PASS if stdout === "HELLO"

./app calculate --add 2 3
# Expected: "5"
# Actual: [captured stdout]
# PASS if stdout contains "5"
\`\`\`

### API Services:

\`\`\`bash
# Test with KNOWN INPUT and verify RESPONSE DATA
curl -s -X POST http://localhost:3000/api/calculate \\
  -H "Content-Type: application/json" \\
  -d '{"a": 2, "b": 3, "op": "add"}'

# Expected: {"result": 5}
# Actual: [response body]
# PASS if response.result === 5

# Verify data persistence
curl -s -X POST http://localhost:3000/api/users \\
  -d '{"name": "Test"}'
# Get the created ID
curl -s http://localhost:3000/api/users/[id]
# PASS if user exists and name === "Test"
\`\`\`

---

## OUTPUT: ${functionalReport}

Create this file:

\`\`\`markdown
# Functional Test Report - Phase ${phaseNumber}, Attempt ${attempt}

**Date:** [timestamp]
**Total Flows:** [count]
**Passed:** [count]
**Failed:** [count]

## Flow Results

### Flow 1: [Name]
- **Input:** [what you did]
- **Expected:** [from spec/criteria]
- **Actual:** [what actually happened - quote the data]
- **Status:** PASS / FAIL
- **Notes:** [any observations]

### Flow 2: [Name]
- **Input:** ...
- **Expected:** ...
- **Actual:** ...
- **Status:** PASS / FAIL

## Acceptance Criteria Results

| # | Criterion | Status | Actual Output |
|---|-----------|--------|---------------|
| 1 | [criterion] | PASS/FAIL | [actual value] |

## Summary

### FAILURES (must fix)
1. [Flow/Criterion]: Expected [X], got [Y]

### Coverage
- Flows tested: X/Y (Z%)
- Criteria tested: X/Y (Z%)
\`\`\`

---

## DONE SIGNAL: ${functionalDone}

When complete:
\`\`\`bash
mkdir -p ${qaDir}
echo "DONE - Functional test completed at $(date -Iseconds)" > ${functionalDone}
\`\`\`

---

## RULES

1. **Verify OUTPUT, not just response** - A button that responds incorrectly is broken
2. **Use REAL data** - Known inputs with expected outputs
3. **Read ACTUAL values** - From DOM, stdout, API response - not just "it worked"
4. **Compare precisely** - Expected vs Actual, document both
5. **Test EVERY acceptance criterion** - This is the contract
6. **Do NOT fix** - Just report failures

Then STOP.
`.trim();
}
