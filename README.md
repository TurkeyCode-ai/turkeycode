# turkey-enterprise-v2

**Deterministic orchestrator for Claude Code sprint workflows.**

v2 is a complete rewrite that fixes v1's context loss and scope creep issues by spawning one Claude Code session per task with hard artifact gates between phases.

## Key Differences from v1

| v1 | v2 |
|----|-----|
| Single long session | One session per task |
| Prompt-based gates | File existence gates |
| Simple tickets | Rich tickets with contracts |
| Full spec to every agent | Scoped context per agent |

## Installation

```bash
npm install -g turkey-enterprise-v2
```

Or run from the repo:

```bash
npm install
npm run build
npm link
```

## Usage

### Run a new project

```bash
turkey-enterprise-v2 run "Build a task management app" --spec spec.md
```

### With Jira and GitHub

```bash
turkey-enterprise-v2 run "Build a task management app" \
  --jira PROJ \
  --github owner/repo \
  --spec spec.md
```

### Resume from where you left off

```bash
turkey-enterprise-v2 resume
```

### Check status

```bash
turkey-enterprise-v2 status
```

### Check a specific gate

```bash
turkey-enterprise-v2 gate research
turkey-enterprise-v2 gate qa-verdict --sprint 1 --attempt 2
```

### Reset state

```bash
turkey-enterprise-v2 reset --force
```

## Architecture

```
orchestrator (TypeScript CLI, NO AI, deterministic loop)
  │
  ├── spawn: research agent → gate: research.done exists
  ├── spawn: plan agent → gate: sprint-plan.json valid (rich tickets)
  │
  └── FOR EACH sprint:
      │
      ├── FOR EACH ticket:
      │   ├── spawn: build agent → gate: build.done exists
      │   └── git commit + push
      │
      ├── Create PR
      │
      ├── QA PHASE (max 3 attempts):
      │   ├── spawn: smoke agent → gate: smoke.done
      │   ├── spawn: functional agent → gate: functional.done
      │   ├── spawn: visual agent → gate: visual.done
      │   ├── spawn: verdict agent → gate: verdict.json CLEAN
      │   └── if NEEDS_FIX → spawn fix agent → retry
      │
      ├── spawn: code review agent
      ├── spawn: AAR agent → updates state.json
      │
      ├── Merge PR
      └── Complete Jira sprint
```

## Key Design Principles

### 1. One Session = One Job

Each `claude --print --dangerously-skip-permissions` invocation gets a single scoped prompt. Build ONE ticket. Run ONE QA phase. Fix ONE set of findings.

### 2. Gates Are Walls

Between every session, the orchestrator checks for specific artifacts. If they don't exist or are invalid: `process.exit(1)`. Not a warning. A hard stop.

### 3. Scope Isolation

- Build agent gets ONE ticket with its `specContext`, `acceptanceCriteria`, `contracts`
- QA agent gets the app URL and feature list. NO repo access. Fresh context.
- Fix agent gets QA findings only. NOT the full verdict history.

### 4. Rich Tickets with Contracts

Every ticket has:
- `specContext` — exact spec excerpt relevant to this ticket
- `acceptanceCriteria` — concrete testable statements
- `contracts.input` — what this ticket consumes
- `contracts.output` — what this ticket produces
- `dependsOn` — explicit ticket dependencies

### 5. State Survives Everything

`state.json` tracks tech context, entities, endpoints, UI pages. When compaction happens, state.json is truth.

## File Structure Produced

```
project/
├── state.json
├── .turkey/
│   ├── reference/
│   │   ├── specs.md
│   │   └── research.done
│   ├── sprint-plan.json
│   ├── plan.done
│   ├── tickets/
│   │   └── PROJ-1/
│   │       └── build.done
│   ├── qa/
│   │   └── sprint-1/
│   │       ├── smoke-1.md
│   │       ├── functional-1.md
│   │       ├── visual-1.md
│   │       └── verdict-1.json
│   ├── reviews/
│   │   └── sprint-1.md
│   └── aar/
│       └── sprint-1.done
└── src/
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JIRA_HOST` | Jira host (e.g., company.atlassian.net) |
| `JIRA_EMAIL` | Your Jira email |
| `JIRA_TOKEN` | Jira API token |
| `JIRA_PROJECT` | Default Jira project key |

Jira and GitHub integrations are optional. If not configured, the orchestrator skips those steps gracefully.

## Gate Reference

| Gate | Artifact | Validation |
|------|----------|------------|
| research | `.turkey/reference/research.done` | exists, specs.md > 200 chars |
| plan | `.turkey/sprint-plan.json` | valid JSON, rich tickets |
| build | `.turkey/tickets/{key}/build.done` | exists |
| qa-smoke | `.turkey/qa/sprint-N/smoke-M.done` | exists |
| qa-functional | `.turkey/qa/sprint-N/functional-M.done` | exists |
| qa-visual | `.turkey/qa/sprint-N/visual-M.done` | exists |
| qa-verdict | `.turkey/qa/sprint-N/verdict-M.json` | verdict === "CLEAN" |
| code-review | `.turkey/reviews/sprint-N.md` | exists |
| aar | `.turkey/aar/sprint-N.done` | exists |

## Deployment to DigitalOcean

Deploy turkey-enterprise-v2 to a DigitalOcean droplet for running orchestrations in the cloud.

### Prerequisites

1. [doctl CLI](https://docs.digitalocean.com/reference/doctl/) installed and authenticated
2. SSH key added to your DigitalOcean account
3. Anthropic API key

### Quick Deploy

```bash
# Set your API key
cp deploy/.env.example deploy/.env
# Edit deploy/.env with your ANTHROPIC_API_KEY

# Deploy (creates s-1vcpu-2gb droplet - $12/mo)
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

### Droplet Sizes

| Size | RAM | CPU | Price | Recommended For |
|------|-----|-----|-------|-----------------|
| s-1vcpu-1gb | 1GB | 1 | $6/mo | Not recommended |
| **s-1vcpu-2gb** | **2GB** | **1** | **$12/mo** | **Default - light workloads** |
| s-2vcpu-4gb | 4GB | 2 | $24/mo | Multiple concurrent sessions |
| s-4vcpu-8gb | 8GB | 4 | $48/mo | Heavy workloads |

```bash
# Deploy with more resources
./deploy/deploy.sh --size s-2vcpu-4gb
```

### Usage on Droplet

```bash
# SSH into the droplet
ssh root@<DROPLET_IP>

# Set your API key (first time)
export ANTHROPIC_API_KEY=sk-ant-...

# Navigate to workspace
cd /workspace

# Run orchestration
turkey-enterprise-v2 run "Build a todo app"

# Check status
turkey-enterprise-v2 status

# Resume if interrupted
turkey-enterprise-v2 resume
```

### Destroy Droplet

```bash
./deploy/deploy.sh --destroy
```

## Docker (Local)

Run locally with Docker:

```bash
# Build
docker build -t turkey-enterprise-v2 .

# Run interactively
docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  turkey-enterprise-v2 run "Build a todo app"
```

Or with docker-compose:

```bash
# Create .env with ANTHROPIC_API_KEY
docker-compose run --rm orchestrate "Build a todo app"
```

## License

MIT
