# 🦃 TurkeyCode

**Describe it. Build it. Deploy it.**

One prompt → fully researched, planned, built, and QA'd application. No babysitting, no copy-paste, no "it works on my machine."

TurkeyCode is an open-source build orchestrator that turns a plain English description into a production-ready app — complete with automated QA, code review, and bug fixes.

```bash
npx turkeycode run "Build a job board with employer dashboards, \
  applicant tracking, and Stripe payments"
```

Then go make coffee. Come back to a working app.

---

## How It Works

TurkeyCode doesn't write code. It **orchestrates** Claude Code through a deterministic pipeline — research, plan, build, test, fix, review — with hard gates between every step. No AI decides what happens next. The orchestrator does.

```
You: "Build me a recipe sharing app"
    │
    ├── 🔍 Research    → tech stack, architecture, prior art
    ├── 📋 Plan        → 2-5 build phases with deliverables
    │
    └── FOR EACH PHASE:
        ├── 🏗️  Build     → one focused coding session
        ├── 🧪 QA        → smoke → functional → visual (parallel)
        ├── 🔧 Fix       → all issues in one session, full context
        ├── 🔁 Retry     → up to 5 QA cycles until clean
        ├── 📝 Review    → code review with actionable feedback
        └── ✅ Merge     → PR merged to main, next phase
```

Every transition has an **artifact gate** — a file that must exist with valid content before the pipeline moves forward. No hallucinated progress. No skipped steps.

## Quick Start

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Max subscription ($100/mo) or Anthropic API key
- Node.js 20+
- Git

### Install

```bash
# From npm (coming soon)
npx turkeycode run "your app description"

# From source
git clone https://github.com/rangerchaz/turkey-enterprise-v3.git
cd turkey-enterprise-v3
npm install
npm run build
npm link
```

### Run Your First Build

```bash
mkdir my-app && cd my-app
turkeycode run "Build a bookmark manager with tags, search, \
  and a Chrome extension. Stack: Next.js, Tailwind, SQLite."
```

### With a Spec File

```bash
turkeycode run "Build a project management tool" --spec spec.md
```

### Resume a Build

```bash
turkeycode resume
```

### Check Status

```bash
turkeycode status
```

## Spawning Long-Running Builds

Builds can take 30-60+ minutes. To run in the background:

```bash
cd /path/to/project
setsid nohup turkeycode run "your description" --verbose \
  > build.log 2>&1 < /dev/null &
```

> ⚠️ **Important:** Use `setsid` to create a new session group. Plain `nohup &` is not enough — most process managers and shell session cleanups will kill the process group on disconnect. `setsid` fully detaches it.

Monitor progress:

```bash
tail -f build.log        # live log
turkeycode status        # structured status
ps aux | grep turkeycode # check it's alive
```

## Key Design Principles

### 🎯 One Session = One Job
Each Claude session gets a single, scoped prompt. Build ONE phase. Run ONE QA tier. Fix ALL issues in one shot. No sprawling multi-hour sessions that lose context.

### 🧱 Gates Are Walls
Between every step, the orchestrator checks for specific artifacts on disk. If they don't exist or are invalid: hard stop. Not a warning. This is what makes it reliable.

### 📦 Phases Over Tickets
No Jira-style ticket fragmentation. Each phase has a name, scope, deliverables, and acceptance criteria. The build agent gets full context. One phase = one coherent chunk of work.

### 🔧 Fix Agents See Everything
Fix sessions get the comprehensive picture: phase deliverables, all blockers, all warnings, smoke report, and previous attempt history. One session fixes everything coherently.

### 👁️ Visual QA Has Memory
On attempt 2+, visual QA gets the previous report so it verifies fixes instead of inventing new cosmetic nits. Consistency across attempts.

### ⚖️ Blockers vs Warnings
Blockers = broken functionality, dead elements, failed acceptance criteria. Warnings = cosmetic polish. Zero blockers = pass, regardless of warning count.

## Architecture

```
project/
├── .turkey/                    # Build state (gitignored)
│   ├── state.json              # Current phase, QA attempts, etc.
│   ├── audit.log               # Timestamped event log
│   ├── reference/
│   │   ├── specs.md            # Research output
│   │   └── research.done       # Gate artifact
│   ├── phase-plan.json         # 2-5 phases with deliverables
│   ├── phases/
│   │   └── phase-1.done        # Build completion gate
│   ├── qa/
│   │   └── phase-1/
│   │       ├── smoke-1.md      # Smoke test report
│   │       ├── functional-1.md # Functional test report
│   │       ├── visual-1.md     # Visual test report
│   │       ├── verdict-1.json  # Pass/fail decision
│   │       └── fixes-1.md      # Fix report
│   ├── screenshots/            # Visual QA captures
│   ├── reviews/                # Code review reports
│   └── aar/                    # After-action reviews
└── src/                        # Your app's source code
```

## Stack-Agnostic QA

The quick-check system auto-detects your project stack before running expensive QA:

| Backend | Frontend | Database |
|---------|----------|----------|
| Node.js, Go, Ruby, Python | React, Vue, Angular, Svelte | PostgreSQL, MySQL, MongoDB |
| .NET, PHP, Rust, Spring | Solid, Astro, Next.js, Nuxt | Redis, SQLite |
| Elixir | | |

It installs missing prerequisites, starts Docker services, verifies DB connections, checks compilation, and confirms the server starts — all before the first QA agent runs.

## Options

```
turkeycode run <description>     # Start a new build
turkeycode resume                # Resume from last checkpoint
turkeycode status                # Show current state
turkeycode reset --force         # Nuke state, start fresh

Options:
  --spec <file>           Spec file for additional context
  --verbose               Show detailed output
  --allow-warnings        Let cosmetic warnings pass QA
  --jira <project>        Create Jira tickets per phase
  --github <owner/repo>   Create PRs per phase
```

## Integrations

### Jira (optional)

```bash
export JIRA_HOST=company.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_TOKEN=your-token
turkeycode run "your app" --jira PROJ
```

### GitHub (optional)

```bash
export GH_TOKEN=your-token
turkeycode run "your app" --github owner/repo
```

## Hosting (Coming Soon)

```bash
turkeycode deploy
# → https://my-app.turkeycode.ai
```

Free tool builds your app. [turkeycode.ai](https://turkeycode.ai) hosts it for you.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (*or use Claude Max via `claude login`) |
| `JIRA_HOST` | No | Jira host |
| `JIRA_EMAIL` | No | Jira email |
| `JIRA_TOKEN` | No | Jira API token |
| `GH_TOKEN` | No | GitHub token |

## Gate Reference

| Gate | Artifact | Validation |
|------|----------|------------|
| research | `reference/research.done` | exists, specs.md > 200 chars |
| plan | `phase-plan.json` | valid JSON, 2-5 phases |
| build | `phases/phase-N.done` | exists |
| qa-smoke | `qa/phase-N/smoke-M.done` | exists |
| qa-functional | `qa/phase-N/functional-M.done` | exists |
| qa-visual | `qa/phase-N/visual-M.done` | exists |
| qa-verdict | `qa/phase-N/verdict-M.json` | 0 blockers |
| code-review | `reviews/phase-N.md` | exists |
| aar | `aar/phase-N.done` | exists |

## Docker

```bash
docker build -t turkeycode .

docker run -it --rm \
  -v $(pwd)/workspace:/workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  turkeycode run "Build a todo app"
```

## Contributing

PRs welcome. The orchestrator is intentionally simple — it's a deterministic loop, not an AI agent. Keep it that way.

## License

MIT

---

Built with 🦃 by [@rangerchaz](https://github.com/rangerchaz)
