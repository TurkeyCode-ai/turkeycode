# turkey-enterprise-v3

**Phase-based orchestrator for Claude Code build workflows.**

v3 replaces v2's sprint/ticket model with a phase-based approach: 2-5 build phases, each with its own branch, QA cycle, and PR. Parallel QA (smoke + functional + visual), comprehensive fix sessions with full project context, and hard artifact gates between every step.

## Installation

```bash
npm install
npm run build
npm link
```

## Usage

### Run a new project

```bash
turkey-enterprise-v3 run "Build a landing page with a contact form" --spec spec.md
```

### With Jira and GitHub

```bash
turkey-enterprise-v3 run "Build a task management app" \
  --jira PROJ \
  --github owner/repo \
  --spec spec.md
```

### Allow cosmetic warnings to pass QA

```bash
turkey-enterprise-v3 run "Build a todo app" --allow-warnings
```

### Resume from where you left off

```bash
turkey-enterprise-v3 resume
```

### Check status

```bash
turkey-enterprise-v3 status
```

### Reset state

```bash
turkey-enterprise-v3 reset --force
```

## Architecture

```
orchestrator (TypeScript CLI, NO AI, deterministic loop)
  │
  ├── spawn: research agent → gate: research.done + specs.md
  ├── spawn: plan agent → gate: phase-plan.json (2-5 phases)
  │
  └── FOR EACH phase:
      │
      ├── Create branch: phase-N/name
      ├── spawn: build agent → gate: build.done
      ├── git commit + push + create PR
      │
      ├── QA CYCLE (max 3 attempts):
      │   ├── Tier 1: spawn smoke agent → gate: smoke.done
      │   │   └── if critical failures → skip to fix
      │   ├── Tier 2+3 (PARALLEL):
      │   │   ├── spawn functional agent → gate: functional.done
      │   │   └── spawn visual agent → gate: visual.done
      │   ├── spawn verdict agent → gate: verdict.json
      │   │   └── blockers = NEEDS_FIX, warnings only = CLEAN
      │   └── if NEEDS_FIX:
      │       └── spawn fix agent (single session, full context) → retry
      │
      ├── spawn: code review agent → gate: review.md
      ├── spawn: AAR agent
      ├── Merge PR to main
      └── Next phase
```

## Key Design Principles

### 1. One Session = One Job

Each `claude --print` invocation gets a single scoped prompt. Build ONE phase. Run ONE QA tier. Fix ALL issues in one session.

### 2. Gates Are Walls

Between every session, the orchestrator checks for specific artifacts. If they don't exist or are invalid: hard stop. Not a warning.

### 3. Phases Over Tickets

Each phase has a name, scope, deliverables, and acceptance criteria. The build agent gets the full phase context. No ticket fragmentation.

### 4. Fix Agents See Everything

Fix sessions get the comprehensive prompt: phase deliverables, all blockers, all warnings, smoke report, and previous attempt history. One session fixes everything coherently instead of N blind sessions each fixing one thing.

### 5. Visual QA Has Memory

On attempt 2+, visual QA gets the previous report so it verifies fixes instead of inventing new cosmetic nits. The verdict agent gets previous verdict context to maintain consistency.

### 6. Blockers vs Warnings

Blockers = broken functionality, dead elements, failed acceptance criteria. Warnings = cosmetic polish. The gate checks arrays directly — zero blockers passes, regardless of warning count (with `--allow-warnings`).

## File Structure

```
project/
├── .turkey/
│   ├── state.json
│   ├── audit.log
│   ├── reference/
│   │   ├── specs.md
│   │   └── research.done
│   ├── phase-plan.json
│   ├── phases/
│   │   └── phase-1.done
│   ├── qa/
│   │   └── phase-1/
│   │       ├── smoke-1.md
│   │       ├── functional-1.md
│   │       ├── visual-1.md
│   │       ├── verdict-1.json
│   │       ├── fixes-1.md
│   │       └── fix-1.done
│   ├── screenshots/
│   │   └── phase-1/
│   │       ├── home-desktop.png
│   │       └── home-mobile.png
│   ├── reviews/
│   │   └── phase-1.md
│   └── aar/
│       └── phase-1.done
└── src/
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (*or use Claude Max `--login`) |
| `JIRA_HOST` | No | Jira host (e.g., company.atlassian.net) |
| `JIRA_EMAIL` | No | Jira email |
| `JIRA_TOKEN` | No | Jira API token |
| `JIRA_PROJECT` | No | Default Jira project key |
| `GH_TOKEN` | No | GitHub token for repo creation |
| `GITHUB_OWNER` | No | GitHub org/user for repos |

Jira and GitHub integrations are optional. If not configured, the orchestrator skips those steps.

## Gate Reference

| Gate | Artifact | Validation |
|------|----------|------------|
| research | `.turkey/reference/research.done` | exists, specs.md > 200 chars |
| plan | `.turkey/phase-plan.json` | valid JSON, 2-5 phases |
| build | `.turkey/phases/phase-N.done` | exists |
| qa-smoke | `.turkey/qa/phase-N/smoke-M.done` | exists |
| qa-functional | `.turkey/qa/phase-N/functional-M.done` | exists |
| qa-visual | `.turkey/qa/phase-N/visual-M.done` | exists |
| qa-verdict | `.turkey/qa/phase-N/verdict-M.json` | 0 blockers (0 warnings if strict) |
| code-review | `.turkey/reviews/phase-N.md` | exists |
| aar | `.turkey/aar/phase-N.done` | exists |

## Deployment (DigitalOcean)

```bash
# Configure
cp deploy/.env.example deploy/.env
# Edit deploy/.env with your keys

# Deploy droplet
./deploy/deploy.sh

# Or use the full launcher with a prompt file
./deploy/launch.sh prompt.md --login
```

### Droplet Sizes

| Size | RAM | CPU | Price | Use Case |
|------|-----|-----|-------|----------|
| s-1vcpu-2gb | 2GB | 1 | $12/mo | Light projects |
| s-2vcpu-4gb | 4GB | 2 | $24/mo | Medium projects |
| **s-4vcpu-8gb** | **8GB** | **4** | **$48/mo** | **Recommended** |

### On the Droplet

```bash
ssh root@<DROPLET_IP>
cd /workspace
turkey-enterprise-v3 run "Build a todo app" --allow-warnings
turkey-enterprise-v3 status
turkey-enterprise-v3 resume
```

### Destroy

```bash
./deploy/deploy.sh --destroy
```

## Docker (Local)

```bash
docker build -t turkey-enterprise-v3 .

docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  turkey-enterprise-v3 run "Build a todo app"
```

## License

MIT
