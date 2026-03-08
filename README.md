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

### Any Stack. Any Platform.

TurkeyCode doesn't care what you're building with.

```bash
# Node/Next.js
turkeycode run "SaaS dashboard with Stripe billing"

# Python/FastAPI
turkeycode run "REST API for inventory management. FastAPI + SQLAlchemy + Postgres."

# Go
turkeycode run "CLI tool that monitors Docker containers. Go + Cobra."

# Rust
turkeycode run "URL shortener. Rust + Axum + SQLite."

# Static site
turkeycode run "Portfolio site with dark mode. HTML + Tailwind + Alpine.js."

# Bring your own Dockerfile
turkeycode run "Build a microservice" --spec spec.md
```

It builds wherever Claude Code runs — Mac, Linux, Docker, cloud VMs. No lock-in.

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

## Stack-Agnostic — Build & Deploy Anything

TurkeyCode auto-detects your project and adapts. Build with any stack, deploy with `turkey deploy`.

| Runtime | Stacks | Database Detection |
|---------|--------|--------------------|
| **Node.js** | Next.js, Express, Fastify, Nest, Hono | Prisma, Drizzle, Mongoose, Knex |
| **Python** | FastAPI, Django, Flask, Starlette | SQLAlchemy, Django ORM, Tortoise |
| **Go** | Gin, Echo, Fiber, Chi, stdlib | GORM, sqlx, ent |
| **Ruby** | Rails, Sinatra, Hanami | ActiveRecord |
| **Rust** | Axum, Actix, Rocket, Warp | Diesel, SQLx, SeaORM |
| **PHP** | Laravel, Symfony, Slim | Eloquent, Doctrine |
| **Static** | HTML, Tailwind, Alpine.js, Astro | — |
| **Docker** | Bring your own Dockerfile | Auto-detected |

The quick-check system installs missing prerequisites, starts Docker services, verifies DB connections, checks compilation, and confirms the server starts — all before the first QA agent runs.

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

## Deploy

Built something? Ship it.

```bash
# Authenticate (once)
turkey login

# Deploy to turkeycode.ai
turkey deploy
# → ✅ Live at https://my-app.turkeycode.ai

# Deploy with a specific tier
turkey deploy --tier starter

# Deploy with a custom subdomain
turkey deploy --name cool-app

# Deploy with env vars
turkey deploy --env .env.production
```

**Hosting tiers:**

| Tier | Price | What you get |
|------|-------|-------------|
| Free | $0/mo | Static hosting, subdomain, sleeps on idle |
| Starter | $12/mo | Full stack (DB + Redis), always-on |
| Pro | $29/mo | + Stripe, Auth, S3, Email, background jobs, custom domain |
| Business | $49/mo | + Priority support, daily backups, analytics |

```bash
# List your deployed apps
turkey apps

# Check app status
turkey apps status my-app

# Tail logs
turkey apps logs my-app

# Tear down
turkey apps delete my-app
```

The CLI auto-detects your stack, generates a Dockerfile if needed, packages your app, and deploys it. If a `Dockerfile` already exists, it's used as-is.

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
