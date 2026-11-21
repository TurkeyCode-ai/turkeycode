# 🦃 TurkeyCode

**Describe it. Build it. Deploy it.**

One prompt → fully researched, planned, built, and QA'd application. No babysitting, no copy-paste, no "it works on my machine."

TurkeyCode is an open-source build orchestrator that turns a plain English description into a production-ready app — complete with automated QA, code review, and bug fixes.

```bash
npx turkeycode run "Build a job board with employer dashboards, \
  applicant tracking, and Stripe payments"
```

It locks the scope with you first — a few quick picks, or skip with `--spec` — then builds heads-down. Go make coffee; come back to a working app.

---

## How It Works

TurkeyCode doesn't write code. It **orchestrates** a coding agent — Claude Code by default; Codex CLI, Gemini CLI, OpenCode, or your own via `--agent` — through a deterministic pipeline: research, plan, build, test, fix, review, with hard gates between every step. No AI decides what happens next. The orchestrator does.

```
You: "Build me a recipe sharing app"
    │
    ├── 🎯 Scope       → converge on what to build (interactive; skippable)
    ├── 🔍 Research    → tech stack, architecture, prior art
    ├── 📋 Plan        → build phases with deliverables (as many as the work needs)
    │
    ├── FOR EACH PHASE:
    │   ├── 🏗️  Build     → one focused coding session
    │   ├── 🧪 QA        → smoke → functional → visual (parallel)
    │   ├── 🔧 Fix       → all issues in one session, full context
    │   ├── 🔁 Retry     → up to 3 QA cycles until clean
    │   ├── 📝 Review    → code review with actionable feedback
    │   └── ✅ Merge     → PR merged to main, next phase
    │
    └── ✨ Polish      → one repo-wide warning cleanup, re-verify build, merge
```

Every transition has an **artifact gate** — a file that must exist with valid content before the pipeline moves forward. No hallucinated progress. No skipped steps.

## Scope First (the prompt is the hard part)

A build is only as good as its spec. Hand `run` a bare description and — when you're at a terminal — it converges with you *before* writing any code: it restates what it thinks you want and hands you the next decision as a short list of **options to pick from**, leaning toward the smaller cut. You ratify by typing a number. It doesn't interrogate you with a wall of questions.

```bash
# Converge interactively, then build straight through
turkeycode run "a habit tracker with streaks and reminders"

# Or scope into a spec without building yet
turkeycode scope "a habit tracker with streaks and reminders"
```

It skips the loop and goes fully autonomous when you pass `--spec`, point it at a spec file, or run non-interactively (CI / piped stdin) — automation never blocks on input.

### Make it think like you

Drop a `persona.md` — your operating manual for how you scope, what you cut, your defaults — and the scope agent **embodies it**, generating the options *you'd* weigh in *your* voice.

```bash
turkeycode run "internal admin tool" --persona persona.md
```

Load order (first found wins): `--persona <file>` → `./.turkey/persona.md` (project) → `~/.turkeycode/persona.md` (global) → a built-in scoping doctrine. So the dialog is always opinionated — narrow, binary, invariants-first; drop your own file to make the options *yours*.

## Quick Start

### Prerequisites

- An agent CLI installed and authenticated — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by default, or Codex CLI / Gemini CLI / OpenCode (see [Agent Backends](#agent-backends))
- For the default backend: Claude Max subscription ($100/mo) or Anthropic API key
- Node.js 20+
- Git

### Install

```bash
# From npm
npx turkeycode run "your app description"

# Or install globally
npm install -g turkeycode

# From source
git clone https://github.com/TurkeyCode-ai/turkeycode.git
cd turkeycode
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

It builds wherever your agent CLI runs — Mac, Linux, Docker, cloud VMs. No lock-in.

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

## Agent Backends

TurkeyCode is not married to one agent. Every phase runs on a pluggable backend; the
orchestrator's contract with a session is agent-neutral (prompts in, artifacts and
done-files on disk out), so anything that can run shell commands and write files can
hold it up.

Built in: `claude` (default), `codex`, `gemini`, `opencode`.

```bash
# Pick a backend per run (or set TURKEYCODE_AGENT)
turkeycode run "your idea" --agent codex
turkeycode run "your idea" --agent gemini

# The choice is pinned in .turkey/state.json — resume stays on the same agent
turkeycode resume
```

| Backend | CLI | Autonomy flags | Models |
|---|---|---|---|
| `claude` | `claude --print` | `--dangerously-skip-permissions` | opus / sonnet / haiku, Fable 5 pinned for build + blocker fixes |
| `codex` | `codex exec` | `--dangerously-bypass-approvals-and-sandbox` | gpt-5-codex tiers |
| `gemini` | `gemini` | `--yolo` | gemini-2.5-pro / flash |
| `opencode` | `opencode run` | `--auto` | your configured opencode default (`-m provider/model`) |

Phases map to backend-neutral tiers (high / medium / low); each backend maps tiers to
its own model names. `TURKEYCODE_MODEL` and `TURKEYCODE_MODEL_<PHASE>` override either
way, in the active backend's vocabulary.

### Bring Your Own Agent

Any print-mode agent CLI can be wired in with zero code changes via
`~/.turkeycode/agents.yaml` (entries can also override the built-ins by id):

```yaml
agents:
  - id: myagent
    displayName: My Agent
    binary: /usr/local/bin/myagent
    baseArgs: ["run", "--auto-approve"]   # print mode + no approval prompts
    promptDelivery: stdin                  # or: arg (prompt as final argv entry)
    modelFlag: "-m"
    env:
      apiKeyVar: MYAGENT_API_KEY
    versionArgs: ["--version"]
    installHint: "brew install myagent"
    classifiers:                           # regex strings, compiled case-insensitive
      rateLimit: ["rate.?limit", "\\b429\\b"]
      creditExhausted: ["quota exceeded"]
      apiErrorContext: ["\\b429\\b", "myvendor"]
    models:
      tiers: { high: big-model, medium: mid-model, low: small-model }
    capabilities:
      subagents: false        # can it spawn subagents in-session? (Claude's Task tool)
      skills: false           # can it load Claude Code skills?
      mcpConfig: false        # does it take an MCP config file flag?
      multimodalImages: false # can its model read screenshots?
```

Capabilities shape the prompts: backends without in-session subagents run visual QA's
blind review as a second fresh session (same blindness, different plumbing), and
backends without vision do a structural review instead of judging screenshots.

## Iterate with Tickets (Jira)

Greenfield gets you the app. Real life is what comes next: bugs and follow-on work.
Tickets are how that work *enters* — TurkeyCode triages each one and decides the build
shape (the no-micro-tickets philosophy is about how the AI *builds*, not how work arrives).

**Bug/story mode — describe it, and TurkeyCode files its own ticket and runs it:**

```bash
# Estimate (auto Bug-vs-Story + Fibonacci points) → create the ticket
# → burn down its epic → run it end to end.
turkeycode story "users can export their dashboard to CSV"

# Omit --epic and you get an interactive epic picker (with each epic's point budget).
# Or pin it directly:
turkeycode story "fix the broken CSV export on empty sets" --epic PROJ-100 --bug

# Estimate only, write nothing:
turkeycode story "add SSO via Okta" --dry-run

# Create + point the ticket but don't build yet:
turkeycode story "rate-limit the public API" --no-run
```

Epic burndown is **read-and-report**: `remaining = epic budget − committed points`.
It never writes back to the epic, so it never fights Jira's native rollup
(`--budget <n>` overrides the pool if the epic isn't pointed).

**Run tickets that already exist:**

```bash
# Run one ticket: triage → research (non-coding) or build + push branches (coding)
turkeycode run-ticket PROJ-123

# Pick from tickets assigned to you
turkeycode my-tickets

# Just classify, change nothing
turkeycode run-ticket PROJ-123 --triage-only

# Deep tier: plan → build → cited review/fix rounds (round 1: ticket + reference
# fidelity; round 2: integration, re-entry, concurrency, bypass paths)
turkeycode run-ticket PROJ-123 --deep --review-rounds 2

# Build on top of an unpushed local stack, keep the result local
turkeycode run-ticket PROJ-123 --deep --base-local stack/week-46 --no-push
```

| Flag | Effect |
|------|--------|
| `--base-local <ref>` | Cut the ticket branch from a **local** ref and rebase onto it (no fetch) instead of `origin/<base>`. A bare `<ref>` applies to every scoped repo where it exists; the others keep `origin/<base>`. Pin per repo with `<repoPath>=<ref>` (comma-separated; the ref must exist there). |
| `--no-push` | Stop after review/fix + rebase: the branch stays local, branch + SHA per repo are printed and written to `~/.turkeycode/tickets/<KEY>/local-branches.json`. No push, no Jira transition; the Jira comment and worklog still happen. |

**Running several tickets at once.** Each `run-ticket` process leaves a marker in `~/.turkeycode/tickets/<KEY>/in-flight.json` while it works. The plan and build sessions are told which other tickets are being built in the same repos and where their plans are, so they can keep shared edits small and record any overlap. It is information, not a lock: nothing waits. The deep tier also rebases before review, so a conflict with a ticket that landed meanwhile is resolved while review rounds are still ahead.

Coding tickets need a manifest at `~/.turkeycode/repos.yaml` (override with `--manifest`):

```yaml
defaultBase: develop
branchPattern: ticket/{key}-{slug}
transitionAfterPush: In Review
repos:                      # repos turkeycode branches, commits and pushes in
  - path: ~/work/api
    role: backend
  - path: ~/work/web
    role: frontend
references:                 # read-only research material (e.g. legacy code being ported)
  - path: ~/legacy/src
    role: legacy system
related:                    # read-only LIVE code the change must stay compatible with
  - path: ~/work/bridge
    role: bridge producer/consumer between legacy and new
review:
  checklist:                # extends the built-in failure-mode checklist
    - Status codes are single letters; blank means active.
  # replaceDefaultChecklist: true   # use only the items above
```

`related` repos are shown to the plan, build, review and fix sessions as the other
side of a contract (bridge, API, queue, shared table); the reviewer is told to open
them and check the contract both ways. They're never branched or written to, and a
path can't be in both `repos` and `related`.

Deep-tier reviews must cite `file:line` evidence for every finding and every
"verified OK" claim; uncited entries are dropped. A review with nothing cited counts
as *not reviewed* (re-run once, then the run fails before anything is pushed).
Review rounds use different lenses, so a clean round 1 still gets a round 2. Each later round verifies the previous fixes and challenges them (a fix can introduce its own problem). If the last scheduled round still finds something, one extra fix → verify round runs; anything left after that is reported as open. `--review-rounds 1` means exactly one review.
The built-in checklist covers sentinel literals in legacy fields, both directions of
every integration, field ownership, bypass paths, re-entry, concurrency, tests that
encode the premise, and constructor/signature churn.

Requires Jira env (`JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN`, and `JIRA_PROJECT` for
`story`). See [Jira Integration](#jira-integration-optional).

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

### ✨ Defer Warnings, Polish Once
By default, phases gate on **blockers only** so a functionally-correct phase merges immediately instead of stalling on lint/style. Warnings accumulate, then a single **polish pass** after the last phase fixes them all coherently across the repo and **re-verifies the build** before merging — a cleanup that breaks compilation or boot is reverted, never merged. The end state is still ZERO warnings, just batched and verified at the end. Use `--strict-phases` to gate every phase on zero warnings (no polish pass), or `--allow-warnings` to leave warnings as-is.

## Architecture

```
project/
├── .turkey/                    # Build state (gitignored)
│   ├── state.json              # Current phase, QA attempts, etc.
│   ├── audit.log               # Timestamped event log
│   ├── persona.md              # Optional: your "how I scope" manual (project-level)
│   ├── reference/
│   │   ├── specs.md            # Confirmed intent spec (scope) + research survey
│   │   ├── scope-working.md    # Living working model (during scope)
│   │   ├── scope-decisions.md  # Decisions + corrections log
│   │   ├── scope.done          # Scope gate artifact
│   │   └── research.done       # Research gate artifact
│   ├── phase-plan.json         # build phases with deliverables (as many as needed)
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
│   ├── aar/                    # After-action reviews (opt-in: --aar)
│   └── polish/                 # End-of-build warning cleanup pass
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
turkeycode run <description>     # Start a new build (converges with you first on a TTY)
turkeycode scope <description>   # Converge on a spec without building
turkeycode resume                # Resume from last checkpoint
turkeycode status                # Show current state
turkeycode reset --force         # Nuke state, start fresh

turkeycode story <description>   # Estimate, file, and run a Jira ticket
turkeycode run-ticket <KEY>      # Run an existing Jira ticket (triage → build)
turkeycode my-tickets            # Pick from tickets assigned to you

Options (run):
  -s, --spec <file>       Spec file for additional context (skips the scope loop)
  --persona <file>        Operating manual the scope agent embodies
  -v, --verbose           Show detailed output
  -w, --allow-warnings    Let cosmetic warnings pass QA (no polish pass)
  --strict-phases         Gate every phase on ZERO warnings (no polish pass)
  --aar                   Generate a per-phase After-Action Report (extra session/phase)
  --type <type>           Force project type (skips auto-detection)
  --base <branch>         Base branch override (defaults to detected main/master)
  --feature <branch>      Feature branch — phases branch off and merge back into it
  --no-push               Skip git push (local-only repos or no_push remotes)
  --no-pr                 Skip gh pr create (implied by --no-push)
  -j, --jira <project>    Create Jira tickets per phase
  -g, --github <repo>     Create PRs per phase (owner/repo)
```

## Simulate

QA answers "does it work?". A simulation answers "does it work for the people it is for?".

`turkeycode simulate` sends simulated first-time visitors through the app you built and scores what happened against thresholds taken from your spec. It uses the separate [SDD engine](https://github.com/TurkeyCode-ai/sdd) (Simulation Driven Development):

```bash
npm install -g sdd-engine && sdd setup    # once

turkeycode simulate                        # the app in this folder, report only
turkeycode run "..." --simulate            # simulate at the end of a build
turkeycode run "..." --simulate-loop       # simulate, revise, simulate again
```

What it does:

1. One session reads `.turkey/reference/specs.md` and designs the study: 5 to 7 visitors drawn from your audience, 2 to 4 questions about the entry page, and up to 2 tasks from your core flows. Two of the visitors are held back.
2. Starts a throwaway copy of the app in Docker, on its own port with its own empty database. Your `.env` is not loaded, so the copy holds no real keys. Pass `--env <file>` for values the app needs to start.
3. Visitors skim the entry page for a fixed time and answer the questions from memory. Then they try each task: they can scroll, click, type, or leave, and leaving is the default.
4. Prints a table and writes `.turkey/simulation/<run>.md`: pass rates with 95% intervals, what visitors missed, where they stopped, and a sample of what went wrong. The copy is destroyed.

**The scores are not calibrated.** The simulated visitors have not been checked against real people. Use a score to compare two versions of your app. It is not a prediction of what real visitors will do, and every report says so.

A threshold counts as met only when the low end of its interval clears it, for the visitors and for the held-back visitors. With few visits most results come back "inside the noise", which is the honest answer.

| Flag | Meaning |
|---|---|
| `--runs <n>` | Visits per visitor and screen size. Default 10. |
| `--budget-usd <n>` | Stop starting new visits once this much is spent at list prices. Default 5. |
| `--regenerate` | Design the study again from the spec. |
| `--env <file>` | Environment for the throwaway copy. |

On `run` and `resume` the same numbers are `--simulate-runs` and `--simulate-budget-usd`.

### The revise loop

`--simulate-loop` is opt-in. After the first simulation, a fix session changes the app, the build is re-verified, and the simulation runs again on a fresh copy:

- A change is kept only if the visitors' score improved. Otherwise the branch goes back to where it was.
- A change that breaks the build is reverted before it is simulated.
- The fix session sees the visitors' results only. The held-back visitors, the study and the judge live in `~/.turkeycode/sim/`, outside the project, so the app cannot be tuned to them.
- It stops when everything passes, after 3 iterations, after 2 in a row that improved nothing, or when the simulation budget (default $20 for the whole loop) is spent.

It works on its own branch, `simulate/revise`, and merges only what was kept and verified.

If the engine, Docker or the `claude` CLI is missing, or the project is not a web app, the simulation says so and is skipped. It never fails a build.

## Deploy

Built something? Ship it to your own DigitalOcean account. turkeycode has no hosting
of its own: `deploy` uses your API token, the droplet is yours, and DigitalOcean bills you.

```bash
# Once: a DigitalOcean API token with read and write access
# (https://cloud.digitalocean.com/account/api/tokens)
turkey login --token dop_v1_...
# or: export DIGITALOCEAN_ACCESS_TOKEN=dop_v1_...

# Deploy the current project
turkey deploy
#   No droplet for this app yet. This will create one in your DigitalOcean account:
#     Name:    my-app
#     Region:  nyc3
#     Size:    s-1vcpu-1gb (1 vCPU, 1024 MB, 25 GB disk)
#     Cost:    $6/mo, billed by DigitalOcean until you delete it
#   Create it? [y/N] y
#   ...
#   ✅ Live at http://203.0.113.9

# HTTPS on your own domain (point its A record at the droplet)
turkey deploy --domain app.example.com

# More than one name: the first serves the app, the rest redirect to it
turkey deploy --domain example.com,www.example.com

# Pick the name, region or size of a new droplet
turkey deploy --name cool-app --region sfo3 --size s-2vcpu-4gb

# Deploy with env vars
turkey deploy --env .env.production
```

**What it does:**

1. Detects your stack and generates a Dockerfile if the project has none (an existing `Dockerfile` is used as-is).
2. The first time, shows the droplet it is about to create and what DigitalOcean charges for it, and asks before creating it (`--yes` skips the question). It is one droplet per app: 1 GB by default, 2 GB when the app needs a database or Redis.
3. Copies the project over SSH and builds it on the droplet with the same Compose services `turkey run-local` uses: your app, plus Postgres, MySQL, MongoDB or Redis when it needs them.
4. Puts Caddy in front on ports 80 and 443. Nothing else is published, so the database is not reachable from the internet.

Run `turkey deploy` again to redeploy to the same droplet. Database volumes and the generated database password stay where they are.

The first deploy takes about five minutes: DigitalOcean creates the droplet, the droplet installs Docker, then the image builds. A redeploy skips all of that and only rebuilds what changed. For a small Node and Postgres app that was 5 minutes 20 seconds the first time and 17 seconds after.

New droplets go in `nyc3` unless you pass `--region`. `--region` and `--size` are only used when the droplet is created; resize or move it in DigitalOcean after that.

Your local `.env` is never uploaded. Only the file you pass with `--env` is, and it goes straight to your droplet.

turkeycode reaches the droplet with its own SSH key, `~/.turkeycode/deploy_key`, created on first use and added to your DigitalOcean account as `turkeycode-deploy`. To redeploy from another machine, copy that key over.

```bash
# List your deployed apps (droplets tagged "turkeycode")
turkey apps

# Check app status
turkey apps status my-app

# Recent container logs
turkey apps logs my-app

# Destroy the droplet, including its database
turkey apps delete my-app --force
```

`apps delete` removes the droplet and stops the billing for it. It leaves the `turkeycode-deploy` SSH key in your DigitalOcean account, ready for the next deploy.

### Non-Web Projects

Built a CLI, library, or desktop app? Deliver it to your GitHub instead:

```bash
# Push to your GitHub with compiled binaries
turkey deliver

# Public repo
turkey deliver --public

# Custom name
turkey deliver --name my-cool-cli
```

Uses your `gh` CLI auth — no extra tokens needed. Go projects get cross-compiled for Linux, macOS, and Windows. Rust projects get a native release build. A GitHub release is created automatically with the binaries.

## Setup

These options apply to the default `claude` backend. Other backends authenticate
through their own CLIs (`codex login`, `gemini`, `opencode auth login`) — see
[Agent Backends](#agent-backends).

### Option A: Claude Max / Pro (Recommended — no API key needed)

If you have a Claude Max or Pro subscription:

```bash
# Install the Claude CLI and log in
npm install -g @anthropic-ai/claude-code
claude login

# That's it — TurkeyCode uses your Claude CLI session automatically
turkeycode run "your idea"
```

### Option B: API Key

If you prefer using an API key directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
turkeycode run "your idea"
```

> ⚠️ API keys are billed per token and can get expensive for large builds. Claude Max ($100/mo or $200/mo) is unlimited and significantly cheaper for this use case.

### GitHub Integration (Optional)

To push builds to GitHub or use `turkey deliver`:

```bash
# Install and authenticate the GitHub CLI
brew install gh  # or: apt install gh
gh auth login

# Now you can push builds and deliver non-web projects
turkeycode run "your idea" --github yourname/repo
turkey deliver
```

### Jira Integration (Optional)

Powers `turkeycode story`, `run-ticket`, and `my-tickets` (see
[Iterate with Tickets](#iterate-with-tickets-jira)):

```bash
export JIRA_HOST=yourcompany.atlassian.net
export JIRA_EMAIL=you@company.com
export JIRA_TOKEN=your-jira-api-token
export JIRA_PROJECT=PROJ   # required for `story` (it creates tickets)
```

Generate a Jira API token at: https://id.atlassian.com/manage-profile/security/api-tokens

`story` resolves your instance's Story Points and Epic Link fields automatically, and
links epics on both team- and company-managed projects.

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No* | Anthropic API key. *Not needed if using Claude Max/Pro via `claude login` |
| `TURKEYCODE_AGENT` | No | Agent backend: `claude` (default), `codex`, `gemini`, `opencode`, or an `agents.yaml` id. Same as `--agent` |
| `TURKEYCODE_MODEL` / `TURKEYCODE_MODEL_<PHASE>` | No | Model override (global / per phase, e.g. `TURKEYCODE_MODEL_QA_FIX`), in the active backend's vocabulary |
| `TURKEYCODE_USE_API_KEY` | No | Set to `1` to keep the vendor API key as the auth source instead of the CLI login session |
| `GH_TOKEN` | No | GitHub token (alternative to `gh auth login`) |
| `JIRA_HOST` | No | Jira instance hostname (e.g. `company.atlassian.net`) |
| `JIRA_EMAIL` | No | Jira account email |
| `JIRA_TOKEN` | No | Jira API token |
| `JIRA_PROJECT` | No | Jira project key. Required for `turkeycode story` (it creates tickets) |

## Gate Reference

| Gate | Artifact | Validation |
|------|----------|------------|
| scope | `reference/scope.done` | starts with `DONE`, specs.md > 200 chars |
| research | `reference/research.done` | exists, specs.md > 200 chars |
| plan | `phase-plan.json` | valid JSON, ≥1 phase |
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

## Troubleshooting

**Build seems stuck?** Check `build.log` or run `turkeycode status`. Each QA cycle can take a few minutes — up to 3 cycles per phase is normal.

**"Claude not found" error?** Make sure Claude Code is installed: `npm install -g @anthropic-ai/claude-code` then `claude login`. (On another backend, preflight prints that CLI's install and setup hints instead.)

**QA keeps failing?** Try `--allow-warnings` to let cosmetic issues pass. If it's looping on real bugs, check `.turkey/qa/` for the latest report.

**Process killed on disconnect?** Use `setsid nohup turkeycode run ... < /dev/null &` — see [Spawning Long-Running Builds](#spawning-long-running-builds).

**Need to start over?** `turkeycode reset --force` nukes the `.turkey/` state directory.

## Contributing

PRs welcome. The orchestrator is intentionally simple — it's a deterministic loop, not an AI agent. Keep it that way.

- **Prompts:** `src/prompts/` — the build, QA, and planning instructions
- **Gates:** `src/gates.ts` — artifact validation logic
- **Orchestrator:** `src/orchestrator.ts` — the main loop
- **Scope:** `src/prompts/scope.ts` + `src/scope-session.ts` — the converge-first correction loop
- **Tests:** `npm test` — 248 tests across 26 modules

Please include tests for new features.

## License

MIT

---

[turkeycode.ai](https://turkeycode.ai) · Built with <🦃/> by [@rangerchaz](https://github.com/rangerchaz)

