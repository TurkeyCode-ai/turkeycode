/**
 * Polish prompt builder — end-of-build warning cleanup pass.
 * Job: discover EVERY warning across the whole repo using the project's own
 * tooling, fix them all to zero, then write a machine-readable verdict + done
 * signal. Runs once after all build phases merge, so it sees the full codebase
 * and can fix a lint rule coherently everywhere at once.
 *
 * The agent must NOT touch state.json — the orchestrator owns that file and
 * concurrent edits corrupt it, killing the phase loop.
 */

import { ProjectState } from '../types';
import { POLISH_DIR } from '../constants';

export function buildPolishPrompt(
  state: ProjectState,
  attempt: number
): string {
  const verdictPath = `${POLISH_DIR}/verdict-${attempt}.json`;
  const doneFile = `${POLISH_DIR}/polish-${attempt}.done`;

  const stack = [state.tech?.backend, state.tech?.frontend, state.tech?.database]
    .filter(Boolean)
    .join(' + ') || state.projectType || 'unknown';

  return `
# POLISH PASS — Repo-Wide Warning Cleanup (attempt ${attempt})

## YOUR SINGLE JOB
Drive ALL warnings to ZERO across the entire codebase, without breaking anything that works. Then write a verdict file. **DO NOT touch \`.turkey/state.json\`** — the orchestrator owns it and concurrent edits corrupt it.

This runs after every build phase has merged, so the whole project is present. Fix issues coherently across the repo (e.g. one lint rule fixed everywhere), not file-by-file.

---

## CONTEXT
**Stack:** ${stack}

---

## PROCEDURE

### 1. DISCOVER — run the project's own tooling
Find and run whatever the project uses, across the WHOLE repo (not a subset). Check \`package.json\` scripts, Makefile, mix.exs, etc. Typical commands:
- Lint: \`npm run lint\`, \`eslint .\`, \`ruff check\`, \`golangci-lint run\`, \`cargo clippy\`, \`mix credo\`
- Types: \`npx tsc --noEmit\`, \`mypy .\`, \`go vet ./...\`
- Build (surfaces compiler warnings): \`npm run build\`, \`cargo build\`, \`mix compile --warnings-as-errors\`
- Format: \`prettier --check .\`, \`gofmt -l .\`, \`black --check .\`

Capture the COMPLETE list of warnings. Do not sample.

### 2. FIX — every warning, to zero
- Fix the root cause, not the symptom. Prefer the correct fix over suppressing.
- **Never** blanket-disable lint rules or add \`// eslint-disable\`, \`@ts-ignore\`, \`#[allow(...)]\` etc. just to silence a warning — that is hiding, not fixing. (A narrowly-scoped, commented suppression for a genuine false-positive is acceptable; note it in the verdict.)
- Some warnings are latent bugs (floating promises, unused imports masking typos, missing hook deps). Treat them as real.
- **Do not change behavior.** This is cleanup, not a refactor. If a "fix" would alter runtime behavior or public API, leave it and record it as \`deferred\` in the verdict instead.

### 3. RE-RUN — confirm zero
Run every discovery command again. Iterate until they report zero warnings (or only documented, justified deferrals remain).

### 4. COMMIT
Commit your changes with a clear message. Do not push, do not open PRs, do not merge — the orchestrator handles git integration.

---

## OUTPUT: ${verdictPath}
Write this exact JSON shape:
\`\`\`json
{
  "verdict": "CLEAN | WARNINGS_REMAIN",
  "remainingWarnings": 0,
  "fixed": <number of warnings fixed>,
  "byCategory": { "lint": 0, "types": 0, "build": 0, "format": 0 },
  "commands": ["<each discovery command you ran>"],
  "deferred": [
    { "warning": "<text>", "file": "<path>", "reason": "<why not fixed — behavior risk / false positive>" }
  ],
  "summary": "<one-paragraph description of what you cleaned up>"
}
\`\`\`
- \`verdict\` is \`CLEAN\` only when \`remainingWarnings\` is 0 (justified \`deferred\` entries don't count as remaining).
- Be honest. A false CLEAN is worse than an accurate WARNINGS_REMAIN — the orchestrator re-verifies the build either way.

---

## DONE SIGNAL: ${doneFile}
After writing the verdict:
\`\`\`bash
mkdir -p ${POLISH_DIR}
echo "DONE - polish attempt ${attempt} at $(date -Iseconds)" > ${doneFile}
\`\`\`

---

## RULES
1. Whole repo, not a subset. Discover exhaustively.
2. Fix root causes; do not mass-suppress.
3. Do NOT change runtime behavior — defer anything risky and record it.
4. **DO NOT touch \`.turkey/state.json\`.**
5. Do not push/merge — just commit.

Then STOP.
`.trim();
}
