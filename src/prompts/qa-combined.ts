/**
 * Combined QA prompt — smoke + functional + verdict in ONE session.
 * v3-fast: Replaces the 4-agent QA carousel (smoke → functional → visual → verdict)
 * with a single comprehensive session.
 */

import { ProjectState, ProjectType, shouldSkipVisualQA } from '../types';
import { QA_DIR, SPECS_FILE } from '../constants';
import { readFileSync, existsSync } from 'fs';

// ==================== Type-Specific QA Instructions ====================

function getSetupInstructions(projectType: ProjectType): string {
  switch (projectType) {
    case 'cli':
      return `### Build the CLI
\`\`\`bash
# Install dependencies and build
npm install 2>/dev/null || pip install -e . 2>/dev/null || cargo build 2>/dev/null || go build 2>/dev/null
npm run build 2>/dev/null || true
\`\`\`

**If the CLI won't build, that's a BLOCKER. Write verdict and stop.**`;

    case 'library':
      return `### Build the library
\`\`\`bash
npm install 2>/dev/null || pip install -e . 2>/dev/null || cargo build 2>/dev/null
npm run build 2>/dev/null || true
\`\`\`

**If the library won't compile, that's a BLOCKER. Write verdict and stop.**`;

    case 'web-api':
      return `### Database
\`\`\`bash
if [ -f prisma/schema.prisma ]; then
  npx prisma db push --skip-generate 2>/dev/null || npx prisma migrate deploy 2>/dev/null
  npx prisma generate 2>/dev/null
  npx prisma db seed 2>/dev/null || true
fi
\`\`\`

### Start the API server
**CRITICAL: Use port 5123** — port 3000 is reserved by the platform.
\`\`\`bash
pkill -f "node " 2>/dev/null || true
sleep 2
PORT=5123 npm start 2>/dev/null || PORT=5123 npm run dev &
sleep 10
\`\`\`

**If the server won't start, that's a BLOCKER. Write verdict and stop.**`;

    case 'desktop':
      return `### Build the desktop app
\`\`\`bash
npm install && npm run build
\`\`\`

**If the app won't build, that's a BLOCKER. Write verdict and stop.**`;

    case 'mobile':
      return `### Build the mobile app
\`\`\`bash
npm install && npx expo build 2>/dev/null || npx react-native build 2>/dev/null || flutter build 2>/dev/null
\`\`\`

**If the app won't build, that's a BLOCKER. Write verdict and stop.**`;

    default: // web-fullstack, web-frontend
      return `### Database
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

**If the app won't start, that's a BLOCKER. Write verdict and stop.**`;
  }
}

function getSmokeInstructions(projectType: ProjectType): string {
  switch (projectType) {
    case 'cli':
      return `Test every command and subcommand FOR THIS PHASE'S DELIVERABLES:

\`\`\`bash
# Test help
./app --help        # Should exit 0, show usage text
./app --version     # Should show version (if applicable)

# Test each command
./app command1 --help
./app command1 [valid-args]
./app command1 [invalid-args]  # Should error gracefully, not crash
\`\`\`

For each command:
- **DEAD** = crashes, hangs, no output, stack trace
- **LIVE** = expected output or helpful error message`;

    case 'library':
      return `Test that the library can be imported and its public API works:

\`\`\`bash
# Node.js
node -e "const lib = require('./dist'); console.log(Object.keys(lib))"

# Python
python -c "import mylib; print(dir(mylib))"

# Rust
cargo test --lib 2>&1
\`\`\`

For each export:
- **DEAD** = import throws, function crashes, types missing
- **LIVE** = import works, functions return expected types`;

    case 'web-api':
      return `Test every API endpoint FOR THIS PHASE'S DELIVERABLES:

\`\`\`bash
curl -s http://localhost:5123/health
curl -s http://localhost:5123/api/[endpoint]
curl -s -X POST http://localhost:5123/api/[endpoint] -H "Content-Type: application/json" -d '{}'
\`\`\`

For each endpoint:
- **DEAD** = 500 error, no response, connection refused
- **LIVE** = correct status code and response format`;

    default: // web apps
      return `Test every interactive element FOR THIS PHASE'S DELIVERABLES:

For web apps, use Playwright:
\`\`\`bash
npx playwright install chromium 2>/dev/null
\`\`\`

Test all buttons, links, inputs, forms. For each:
- **DEAD** = no response when clicked/submitted
- **LIVE** = something happens (page change, modal, toast, data update)`;
  }
}

function getFunctionalInstructions(projectType: ProjectType): string {
  switch (projectType) {
    case 'cli':
      return `For each deliverable and acceptance criterion, verify correct OUTPUT:

\`\`\`bash
# Test with known inputs, verify expected outputs
echo "test input" | ./app process
# Expected: specific output
# Actual: [captured stdout]
# PASS if matches

./app generate --template react my-app
# Expected: exit 0, directory "my-app" created with package.json
# Actual: check exit code + ls my-app/

./app invalid-command
# Expected: exit code 2, helpful error to stderr
# Actual: check $? and stderr
\`\`\`

- Verify exit codes (0 = success, 1 = error, 2 = usage error)
- Verify stdout contains expected output
- Verify stderr is clean on success
- Test piping if applicable`;

    case 'library':
      return `For each deliverable, verify the public API works correctly:

\`\`\`bash
# Run existing test suite
npm test 2>/dev/null || pytest 2>/dev/null || cargo test 2>/dev/null || go test ./... 2>/dev/null

# Or create a quick integration test
node -e "
  const lib = require('./dist');
  // Test each public function
  const result = lib.someFunction('input');
  console.log(result === expected ? 'PASS' : 'FAIL');
"
\`\`\`

- Verify return types match documentation
- Test edge cases (empty input, null, large input)
- Test error handling (invalid inputs should throw typed errors)`;

    case 'web-api':
      return `For each deliverable and acceptance criterion, verify correct API OUTPUT:

\`\`\`bash
# Test CRUD lifecycle
ID=$(curl -s -X POST http://localhost:5123/api/items -H "Content-Type: application/json" -d '{"name":"test"}' | jq -r '.id')
curl -s http://localhost:5123/api/items/$ID  # Should return the item
curl -s -X PUT http://localhost:5123/api/items/$ID -d '{"name":"updated"}'
curl -s -X DELETE http://localhost:5123/api/items/$ID
curl -s http://localhost:5123/api/items/$ID  # Should 404

# Test error cases
curl -s -X POST http://localhost:5123/api/items -d '{}'  # Should 422
curl -s http://localhost:5123/api/items/nonexistent       # Should 404
\`\`\`

- Verify response status codes and body shapes
- Verify data persistence (create → read → verify)
- Test auth guards if applicable (mutating routes without token → 401)`;

    default: // web apps
      return `For each deliverable and acceptance criterion, verify correct OUTPUT:
- INPUT → ACTION → VERIFY OUTPUT
- Don't just check "it responds" — check "it does the RIGHT THING"
- Verify data persistence (reload after save, check it's still there)
- Use Playwright for browser flows, curl for API endpoints

### Security checks (if app has user accounts):
- Auth guards on mutating routes (should 401 without login)
- Input sanitization (try \`<script>alert('xss')</script>\` in text fields)`;
  }
}

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

**Project type: ${state.projectType || 'web-fullstack'}**

${getSetupInstructions(state.projectType || 'web-fullstack')}

---

## STEP 2: SMOKE TEST

${getSmokeInstructions(state.projectType || 'web-fullstack')}

---

## STEP 3: FUNCTIONAL TEST

${getFunctionalInstructions(state.projectType || 'web-fullstack')}

### Core flows from specs:
${flows}

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
