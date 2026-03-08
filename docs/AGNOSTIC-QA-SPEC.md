# Stack & Platform Agnostic QA Spec

## Problem

The orchestrator currently assumes every project is a web app. QA smoke tests hit `localhost:5123`, functional tests use Playwright browsers, visual QA takes screenshots of web pages. This makes it useless for CLIs, libraries, desktop apps, mobile apps, APIs without frontends, etc.

TurkeyCode should build **anything** — the QA pipeline must adapt.

---

## Project Type Detection

Before QA runs, detect what kind of project this is. This determines which QA tiers apply and how they execute.

```typescript
type ProjectType = 
  | 'web-fullstack'    // Frontend + backend (Next.js, Rails, Django, etc.)
  | 'web-frontend'     // SPA/static frontend only (Vite, CRA, Astro, etc.)
  | 'web-api'          // Backend API only, no frontend (Express, FastAPI, Go service, etc.)
  | 'cli'              // Command-line tool
  | 'library'          // npm package, pip package, Go module, crate, gem, etc.
  | 'desktop'          // Electron, Tauri, Qt, etc.
  | 'mobile'           // React Native, Flutter, Swift, Kotlin, etc.
  | 'monorepo'         // Multiple project types in one repo
  | 'unknown'          // Can't determine — fall back to basic compilation checks
```

### Detection Heuristics

| Signal | Suggests |
|--------|----------|
| `next`, `nuxt`, `sveltekit`, `remix` in deps | `web-fullstack` |
| `vite`, `react`, `vue` (no server framework) | `web-frontend` |
| `express`, `fastapi`, `gin`, `axum` (no frontend) | `web-api` |
| `bin` field in package.json | `cli` |
| `commander`, `yargs`, `clap`, `cobra`, `click`, `argparse` in deps | `cli` |
| `main` field + no bin/server deps | `library` |
| `electron`, `tauri` in deps | `desktop` |
| `react-native`, `expo` in deps | `mobile` |
| `flutter` project structure | `mobile` |
| `workspaces` in package.json or `pnpm-workspace.yaml` | `monorepo` |
| Cargo.toml with `[[bin]]` | `cli` |
| Cargo.toml with `[lib]` only | `library` |
| `setup.py`/`pyproject.toml` with console_scripts | `cli` |
| go main package with no HTTP listener | `cli` |

### Resolution Order

1. Check explicit metadata if present (`.turkey/project-type` file or `turkey.type` in package.json)
2. Apply heuristics from the table above
3. If ambiguous, prefer the more capable type (e.g., `web-fullstack` over `web-api`)
4. If unknown, fall back to compilation checks only

---

## QA Tiers by Project Type

| Tier | web-fullstack | web-frontend | web-api | cli | library | desktop | mobile |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Quick Check** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Smoke** | ✅ server + pages | ✅ dev server + pages | ✅ server + health | ✅ --help + basic run | ✅ import/require | ✅ builds + launches | ✅ builds |
| **Functional** | ✅ browser + API | ✅ browser | ✅ API/curl | ✅ CLI scenarios | ✅ test suite | ✅ basic flows | ✅ basic flows |
| **Visual** | ✅ screenshots | ✅ screenshots | ❌ skip | ❌ skip | ❌ skip | ✅ if headless | ✅ if emulator |

---

## Quick Check (All Project Types)

Universal checks that apply to every project:

```
1. Project files exist (package.json, go.mod, Cargo.toml, etc.)
2. Dependencies install successfully
3. Project compiles/builds without errors
4. Linter passes (if configured)
5. Existing test suite passes (if present)
```

### Per-Type Quick Checks

**web-fullstack / web-frontend / web-api:**
- Docker services start (if docker-compose exists)
- Database connects (if DB detected)
- Server starts and responds on expected port

**cli:**
- Binary/entry point exists after build
- `--help` flag runs and exits 0
- `--version` flag runs (if applicable)

**library:**
- Package exports are valid (no missing main/exports)
- TypeScript types compile (if TS)
- `import`/`require` doesn't throw

**desktop:**
- Build produces an executable/bundle
- App launches in headless mode (if supported)

**mobile:**
- Build succeeds for target platform
- No build warnings that indicate runtime failures

---

## Smoke Test Prompts by Type

### web-fullstack / web-frontend

_(Current behavior — mostly unchanged)_

```
Start the dev server. Visit each page/route listed in deliverables.
For each page:
- Does it load without errors? (check console)
- Are key elements present? (headers, forms, buttons)
- Are there dead links or broken images?
Report: LIVE elements, DEAD elements, console errors.
```

### web-api

```
Start the server. For each endpoint in deliverables:
- Does the health/root endpoint respond?
- Do key endpoints return expected status codes?
- Is the response format correct (JSON, etc.)?
- Are auth endpoints reachable (if applicable)?
Do NOT test with a browser. Use curl/fetch only.
Report: endpoint, method, status code, pass/fail.
```

### cli

```
Run the built CLI binary/script. Test:
1. `<cmd> --help` exits 0 and shows usage text
2. `<cmd> --version` shows a version (if applicable)
3. Run with a basic valid input from the spec → check exit code and output
4. Run with invalid/missing input → check it errors gracefully (not a stack trace)
5. Check that output format matches spec (JSON, table, plain text, etc.)
Report: command, args, exit code, output snippet, pass/fail.
```

### library

```
Create a minimal test script that:
1. Imports/requires the library's main export
2. Calls key functions from the public API
3. Verifies return types are correct
4. Checks that TypeScript types work (if TS library)
5. Runs the library's own test suite if it exists (`npm test`, `pytest`, `cargo test`, etc.)
Report: import success, function calls, test suite results.
```

### desktop

```
Build the application. Then:
1. Verify the build output exists (binary, .app, .exe, etc.)
2. Launch in headless/test mode if supported
3. Check for startup crashes (exit code, stderr)
4. If the app exposes a dev tools port, check it responds
Report: build success, launch success, errors.
```

### mobile

```
Build for the target platform. Then:
1. Verify the build output exists (APK, IPA, bundle)
2. If an emulator/simulator is available, install and launch
3. Check for startup crashes in logs
4. Run any existing integration tests
Report: build success, install success, launch success, errors.
```

---

## Functional Test Prompts by Type

### web-fullstack / web-frontend

_(Current behavior — Playwright browser tests + curl for APIs)_

Test each flow from the spec: user registration, form submission, CRUD operations, etc. Use Playwright for browser flows, curl for API endpoints.

### web-api

```
For each flow in the spec:
1. Make the HTTP request(s) with curl or fetch
2. Verify response status codes
3. Verify response body matches expected shape
4. Test error cases (400, 401, 404, 422)
5. Test auth flow if applicable (get token → use token → verify)
6. Test CRUD lifecycle (create → read → update → delete → verify gone)
Do NOT use a browser. This is a headless API.
```

### cli

```
For each feature in the spec:
1. Run the command with the specified args
2. Verify exit code (0 for success, non-zero for expected errors)
3. Verify stdout matches expected output (exact or pattern)
4. Verify stderr is clean on success
5. Test piping: can output be piped to another command?
6. Test file I/O: if the CLI reads/writes files, verify the files
7. Test interactive prompts if applicable (provide stdin)
Example test format:
  $ my-cli generate --template react my-app
  Expected: exit 0, directory "my-app" created, contains package.json
```

### library

```
Write integration tests that exercise the public API:
1. Import the library
2. Test each exported function/class with valid inputs
3. Test edge cases (empty input, large input, null)
4. Test error handling (invalid inputs throw/return errors)
5. If the library has async operations, test them
6. Verify TypeScript types match runtime behavior
Run with the project's test runner or a standalone script.
```

### desktop

```
If the app supports automation (Electron: Spectron/Playwright, Tauri: WebDriver):
1. Launch the app in test mode
2. Verify main window appears
3. Test key user flows from the spec
4. Verify data persistence (if applicable)
If no automation available, fall back to build verification only.
```

### mobile

```
If emulator is available and testing framework exists:
1. Install on emulator
2. Launch and verify main screen renders
3. Test key navigation flows
4. Test data entry and persistence
If no emulator, fall back to build verification + lint checks.
```

---

## Visual QA by Type

### web-fullstack / web-frontend

_(Current behavior — screenshots at desktop/tablet/mobile viewports)_

### web-api / cli / library

**Skip entirely.** No visual component.

### desktop

If the app can be launched in headless mode and screenshots can be captured:
- Screenshot the main window
- Screenshot key dialogs/panels from the spec
- Check for layout issues, missing elements

If not possible, skip visual QA.

### mobile

If an emulator with screenshot capability is available:
- Screenshot the main screen
- Screenshot key flows from the spec
- Check for layout issues at different screen sizes

If not possible, skip visual QA.

---

## Verdict Prompt Changes

The verdict prompt needs to understand that not all tiers apply:

```
Project type: {projectType}
QA tiers executed: {tiersRun}    // e.g., ["smoke", "functional"] (no visual for CLI)
QA tiers skipped: {tiersSkipped} // e.g., ["visual"] with reason

Evaluate ONLY the tiers that were executed.
A project that correctly skips visual QA is NOT penalized for having no screenshots.
```

---

## Build Prompt Changes

The build prompt currently includes web-specific instructions:
- "No hardcoded localhost URLs"
- OAuth callback URL guidance
- CORS configuration
- Admin routes for content moderation
- Browser-specific concerns

### Fix: Conditional Build Instructions

```typescript
function getBuildInstructions(projectType: ProjectType): string {
  const common = `
    - Write clean, production-ready code
    - Handle errors gracefully
    - Follow the language/framework conventions
    - Include proper logging
  `;

  switch (projectType) {
    case 'web-fullstack':
    case 'web-frontend':
      return common + webInstructions;  // current behavior
    case 'web-api':
      return common + apiInstructions;  // no frontend concerns
    case 'cli':
      return common + cliInstructions;  // exit codes, --help, stdin/stdout
    case 'library':
      return common + libraryInstructions;  // exports, types, docs
    case 'desktop':
      return common + desktopInstructions;  // window management, packaging
    case 'mobile':
      return common + mobileInstructions;  // platform APIs, permissions
  }
}
```

### CLI-Specific Build Instructions

```
- Implement --help with clear usage text for every command/subcommand
- Implement --version flag
- Use proper exit codes (0 = success, 1 = error, 2 = usage error)
- Write to stdout for normal output, stderr for errors/warnings
- Support piping (don't add colors/spinners when stdout is not a TTY)
- Handle SIGINT gracefully (cleanup temp files, close connections)
- Respect XDG base directories for config/cache/data
```

### Library-Specific Build Instructions

```
- Export a clean public API (index.ts / __init__.py / lib.rs)
- Include TypeScript types (if JS/TS library)
- Write JSDoc/docstrings for all public functions
- Include a README with usage examples
- Don't bundle unnecessary dependencies
- Ensure tree-shaking works (if applicable)
```

---

## Quick-Check Refactor

`quick-check.ts` currently has a web-centric flow:

```
current: detectProject → installPrereqs → startDocker → checkDB → checkBackend → checkFrontend
```

New flow:

```
new: detectProjectType → installPrereqs → typeSpecificChecks
```

### Type-Specific Checks

**web-fullstack:**
```
startDocker → checkDB → checkBackendBuild → checkBackendStarts → checkFrontendBuild → checkFrontendStarts
```

**web-api:**
```
startDocker → checkDB → checkBackendBuild → checkBackendStarts
```
(no frontend checks)

**cli:**
```
checkBuild → checkBinaryExists → checkHelpFlag
```
(no Docker, no DB, no server)

**library:**
```
checkBuild → checkExports → runExistingTests
```

**desktop:**
```
checkBuild → checkBundleExists
```

**mobile:**
```
checkBuild → checkBundleExists
```

---

## Implementation Order

1. **Add ProjectType detection** to orchestrator state (new field in state.json)
2. **Refactor quick-check.ts** — route to type-specific check functions
3. **Refactor QA smoke prompt** — conditional by project type
4. **Refactor QA functional prompt** — conditional by project type
5. **Refactor QA visual prompt** — skip for non-visual project types
6. **Refactor QA verdict prompt** — aware of which tiers were skipped
7. **Refactor build prompt** — conditional instructions by project type
8. **Update research/plan prompts** — don't assume web terminology
9. **Tests** — add test cases for CLI, library, API project types

---

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `ProjectType` type, add to `ProjectState` |
| `src/quick-check.ts` | Refactor to route by project type |
| `src/prompts/build.ts` | Conditional instructions per project type |
| `src/prompts/qa-smoke.ts` | Type-specific smoke test prompts |
| `src/prompts/qa-functional.ts` | Type-specific functional test prompts |
| `src/prompts/qa-visual.ts` | Skip for non-visual types |
| `src/prompts/qa-verdict.ts` | Handle skipped tiers |
| `src/prompts/research.ts` | Remove web-only assumptions |
| `src/prompts/plan.ts` | Remove web-only assumptions |
| `src/orchestrator.ts` | Detect project type, pass to QA, skip visual when appropriate |
| `src/state.ts` | Persist projectType in state.json |
| `src/deploy/detect.ts` | Share detection logic with orchestrator |

---

## Backwards Compatibility

- Default behavior for ambiguous projects = `web-fullstack` (current behavior)
- Existing web app builds work exactly as before
- No breaking changes to state.json format (new field is additive)
- CLI `--project-type <type>` flag for manual override when detection is wrong
