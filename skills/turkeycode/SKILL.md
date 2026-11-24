---
name: turkeycode
description: "Run, monitor, and manage TurkeyCode CLI builds. Use when: (1) building/creating apps with turkeycode, (2) checking build status, (3) restarting failed builds, (4) reviewing build results/verdicts. NOT for: editing TurkeyCode source code itself (use coding-agent), deploying a built app to DigitalOcean (use `turkeycode deploy` directly)."
---

# TurkeyCode Build Skill

Manage TurkeyCode CLI builds — start, monitor, check results.

## Command

Use the installed `turkeycode` command (`npm install -g turkeycode`). When working from a
source checkout, run `npm run build` there after any source change; `npm link` makes that
build the `turkeycode` on your PATH.

## Starting a Build

**CRITICAL:** Always use `setsid nohup ... < /dev/null &` — OpenClaw's exec kills process groups on timeout.

```bash
mkdir -p ~/test-builds/<project-name>
cd ~/test-builds/<project-name> && setsid nohup turkeycode run "<description>" --verbose > build.log 2>&1 < /dev/null &
```

### With a spec file:
```bash
setsid nohup turkeycode run "<description>" --spec spec.md --verbose > build.log 2>&1 < /dev/null &
```

### Clean restart (wipe previous state):
```bash
rm -rf ~/test-builds/<project-name> && mkdir -p ~/test-builds/<project-name>
cd ~/test-builds/<project-name> && setsid nohup turkeycode run "<description>" --spec <spec.md> > build.log 2>&1 &
```
`setsid` is Linux only; on macOS use `nohup ... &` alone. To keep the folder and clear only the previous run:
```bash
turkeycode reset --force   # keeps spec, scope, persona, logs; clears state, plan and QA markers
```

## Checking Status

### Quick status (last 5 lines of log):
```bash
tail -5 ~/test-builds/<project-name>/build.log
```

### Detect current phase:
```bash
grep -E "RESEARCH|PLAN|BUILD|QA|MERGE|ERROR|CLEAN|FAILED" ~/test-builds/<project-name>/build.log | tail -5
```

### Check if process is still running:
```bash
ps aux | grep "test-builds/<project-name>" | grep -v grep
```

### Check QA verdict:
```bash
cat ~/test-builds/<project-name>/.turkey/qa/phase-1/verdict-*.json 2>/dev/null | jq '.verdict' 2>/dev/null
```

## Build Lifecycle

1. **Research** — gathers context, writes specs (only when the folder has no code yet)
2. **Plan** — creates phase-plan.json with N sprints
3. **Build** — Claude writes code (one session per sprint)
4. **Quick Check** — smoke test
5. **QA** — combined QA session plus a blind visual review (up to 3 attempts)
6. **Code review** — critical findings get one fix, kept only if QA passes
7. **Merge** — merge phase branch into the base branch
8. **Next phase** — repeat from step 3, then a polish pass for leftover warnings

## Common Failures

### master→main merge error
```
error: pathspec 'main' did not match any file(s) known to git
```
**Fix:** Already handled by `ensureMainBranch()` in latest build. Rebuild dist.

### Research gate failure
```
Gate research FAILED
```
**Cause:** Research session didn't write completion marker. Restart clean.

### Process killed / build.log stops updating
**Cause:** Forgot `setsid`. The exec session killed the process group.

### QA keeps failing
Check verdict files for specifics:
```bash
cat ~/test-builds/<project-name>/.turkey/qa/phase-1/verdict-*.json 2>/dev/null
```
Warnings never fail QA by default; only blockers do. Under `--strict-phases`, a phase with only warnings left is accepted after two attempts.

## Monitoring Multiple Builds

```bash
for dir in ~/test-builds/*/; do
  name=$(basename "$dir")
  status=$(grep -oE "CLEAN|ERROR|FAILED|BUILD PHASE|QA|RESEARCH|PLAN" "$dir/build.log" 2>/dev/null | tail -1)
  running=$(ps aux | grep "test-builds/$name" | grep -v grep | wc -l)
  echo "$name: ${status:-no log} (${running:+running}${running:-done})"
done
```

## Key Paths

| Path | Purpose |
|------|---------|
| `build.log` | Full build output |
| `.turkey/state.json` | Orchestrator state |
| `.turkey/reference/specs.md` | Generated spec |
| `.turkey/phase-plan.json` | Phase plan |
| `.turkey/phases/phase-N/build.done` | Build completion marker |
| `.turkey/qa/phase-N/verdict-*.json` | QA verdicts |

## Project Types

TurkeyCode detects project type automatically:
- **web-fullstack** — Node/React/Next.js (default for ambiguous)
- **web-frontend** — Static/SPA
- **web-api** — Backend API only
- **cli** — Command-line tools (Go, Rust, Node, Python)
- **library** — Packages/modules
- **desktop** — Desktop apps
- **mobile** — Mobile apps
- **game-godot** — Godot games
- **embedded**, **legacy** — firmware and older codebases
- **monorepo** — Multi-package projects

Visual QA runs for web-fullstack, web-frontend, desktop, mobile and game-godot. The other types skip it.
