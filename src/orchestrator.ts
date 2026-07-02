/**
 * Main orchestrator for turkeycode
 * Phase-based model: N build phases (as many as the work needs), each one Claude session
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import {
  ProjectState,
  BuildPhase,
  SpawnResult,
  ProjectType
} from './types';
import {
  loadState,
  saveState,
  initState,
  loadPhasePlan,
  advancePhase
} from './state';
import { Spawner, createSpawner } from './spawner';
import { Gates, createGates, enforceGate } from './gates';
import { JiraClient, createJiraClient } from './jira';
import { GitHubClient, createGitHubClient, slugify } from './github';
import {
  buildResearchPrompt,
  buildPlanPrompt,
  buildBuildPhasePrompt,
  buildQaSmokePrompt,
  buildQaFunctionalPrompt,
  buildQaVisualPrompt,
  buildQaVerdictPrompt,
  buildQaFixPrompt,
  buildQaCombinedPrompt,
  buildCodeReviewPrompt,
  buildAarPrompt,
  buildPolishPrompt,
  buildMergeFixPrompt
} from './prompts';
import {
  RESEARCH_TIMEOUT_MS,
  PLAN_TIMEOUT_MS,
  PHASE_BUILD_TIMEOUT_MS,
  QA_TIMEOUT_MS,
  AAR_TIMEOUT_MS,
  FIX_TIMEOUT_MS,
  MAX_BUILD_RETRIES,
  MAX_QA_ATTEMPTS,
  MAX_QA_ATTEMPTS_WARNINGS_ONLY,
  MAX_RATE_LIMIT_RETRIES,
  QA_DIR,
  SCREENSHOTS_DIR,
  RESEARCH_DONE,
  SCOPE_DONE,
  PLAN_DONE,
  PHASES_DIR,
  PHASE_PLAN_FILE,
  REFERENCE_DIR,
  SPECS_FILE,
  REVIEWS_DIR,
  AAR_DIR,
  POLISH_DIR,
  POLISH_TIMEOUT_MS,
  MAX_POLISH_ATTEMPTS,
  getModelForPhase
} from './constants';
import { audit, auditGate, auditPhase, auditBuildPhase, auditQA } from './audit';
import { runQuickChecks } from './quick-check';
import { detectProjectTypeStrict, inferProjectTypeFromDescription } from './detect-project-type';
import { shouldSkipVisualQA } from './types';

export interface OrchestratorOptions {
  verbose?: boolean;
  jiraProject?: string;
  githubRepo?: string;
  specFile?: string;
  noPush?: boolean;
  noPr?: boolean;
  /** Generate a per-phase After-Action Report (extra LLM session per phase). Off by default — nothing downstream consumes it. */
  aar?: boolean;
  /** Run the end-of-build polish pass: one session that drives all warnings to zero across the repo, then verifies the build. On by default (defer-warnings model). */
  polish?: boolean;
  /** Force the project type (skips auto-detection). Essential for greenfield builds where the dir is empty. */
  projectType?: ProjectType;
  /**
   * When the project is already complete, re-plan a fresh iteration from the provided spec
   * instead of no-op'ing. Set by the `run` command (which always means "build this spec");
   * left unset by `resume` (which should report a finished project as done, not rebuild it).
   */
  replanIfComplete?: boolean;
  /**
   * Base branch override. Defaults to detected main/master.
   * Use this when working on a develop-based gitflow repo.
   */
  base?: string;
  /**
   * Feature branch. When set, phase branches branch off this and merge
   * back into this. The base branch is never touched. Use for established
   * repos where direct commits to develop/main aren't allowed.
   */
  feature?: string;
}

/**
 * A phase's `build.done` marker is stale when the phase plan was regenerated
 * after it was written — i.e. `phase-plan.json` is newer than `build.done`.
 * This happens on a replan (a new iteration renumbers its phases 1..N, reusing
 * the same on-disk paths as the previous iteration). A stale marker must not be
 * trusted to mean "this phase is built" — doing so is what let a replanned run
 * "complete" without building anything. Shared by the build-skip check and the
 * resume reconciler so both apply the identical rule.
 */
export function isBuildDoneStale(workDir: string, buildDonePath: string): boolean {
  try {
    const planPath = join(workDir, PHASE_PLAN_FILE);
    if (existsSync(planPath) && existsSync(buildDonePath)) {
      return statSync(planPath).mtimeMs > statSync(buildDonePath).mtimeMs;
    }
  } catch { /* stat error — treat as not-stale, fall through to other checks */ }
  return false;
}

/**
 * Directories turkeycode must never initialize a project into — your home dir or a
 * system root. Building there git-inits and writes files across the whole tree.
 * Exact-match only, so any subdirectory (e.g. ~/projects/app, /tmp/build) is fine.
 * Pure for testing.
 */
/**
 * A fix session was a no-op when HEAD is unchanged from the pre-fix snapshot —
 * the agent committed nothing, so re-running QA would only repeat the verdict.
 * Pure decision (no git/IO) so it's unit-testable; the caller supplies both SHAs.
 */
export function isNoopFix(currentHead: string | null, preFixSha: string | null): boolean {
  return !!preFixSha && !!currentHead && currentHead === preFixSha;
}

/** A finding as the verdict/visual JSON carries it. */
export interface QaFinding {
  type?: string;
  description?: string;
  location?: string;
  severity?: string;
}

/**
 * Pure merge: fold a visual QA report's findings into a phase verdict so its
 * blockers gate the phase exactly like functional blockers. Visual findings are
 * normalized to `type: 'visual'`; any visual blocker flips the verdict to
 * NEEDS_FIX. Returns a new verdict object (does not mutate the input). Extracted
 * from the orchestrator so the merge rules can be unit-tested without file I/O.
 */
export function mergeVisualIntoVerdict(
  verdict: Record<string, unknown>,
  visual: { blockers?: QaFinding[]; warnings?: QaFinding[] }
): Record<string, unknown> {
  const visualBlockers = Array.isArray(visual.blockers) ? visual.blockers : [];
  const visualWarnings = Array.isArray(visual.warnings) ? visual.warnings : [];

  const blockers = [
    ...((verdict.blockers as QaFinding[]) || []),
    ...visualBlockers.map((b) => ({
      type: 'visual',
      description: b.description || 'visual blocker',
      location: b.location || 'unknown',
      severity: b.severity || 'critical'
    }))
  ];
  const warnings = [
    ...((verdict.warnings as QaFinding[]) || []),
    ...visualWarnings.map((w) => ({
      type: 'visual',
      description: w.description || 'visual warning',
      location: w.location || 'unknown'
    }))
  ];

  const summary = (verdict.summary as Record<string, unknown>) || undefined;
  return {
    ...verdict,
    blockers,
    warnings,
    // A clean combined verdict must flip to NEEDS_FIX once visual adds a blocker.
    verdict: blockers.length > 0 ? 'NEEDS_FIX' : verdict.verdict,
    ...(summary
      ? {
          summary: {
            ...summary,
            visual: {
              passed: visualBlockers.length === 0,
              blockers: visualBlockers.length,
              warnings: visualWarnings.length
            }
          }
        }
      : {})
  };
}

export function isUnsafeWorkDir(dir: string, home: string): boolean {
  const norm = (p: string): string => p.replace(/[/\\]+$/, '') || '/';
  const d = norm(dir);
  if (d === norm(home)) return true;
  if (/^[A-Za-z]:$/.test(d)) return true; // Windows drive root (C:)
  const roots = ['/', '/root', '/home', '/Users', '/usr', '/etc', '/var', '/bin', '/sbin', '/opt', '/tmp', '/Library', '/System', '/Applications'];
  return roots.includes(d);
}

/**
 * Main orchestrator class
 * Phase-based: N build phases (as many as the work needs), each one Claude session
 */
export class Orchestrator {
  private state: ProjectState;
  private spawner: Spawner;
  private gates: Gates;
  private jira: JiraClient;
  /** Jira is opt-in for builds: configured AND explicitly requested (--jira / JIRA_ENABLED). */
  private jiraEnabled = false;
  private github: GitHubClient;
  private verbose: boolean;
  private workDir: string;
  private aar: boolean;
  private polish: boolean;
  private baseBranch?: string;
  private featureBranch?: string;

  constructor(options: OrchestratorOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.aar = options.aar ?? false;
    this.polish = options.polish ?? false;
    this.workDir = process.cwd();
    this.state = loadState();
    this.spawner = createSpawner({ verbose: this.verbose });
    this.gates = createGates();
    this.jira = createJiraClient(options.jiraProject || this.state.jiraProject);
    // Jira is OPT-IN for a build: it engages only when explicitly requested via
    // --jira <project> (or a resumed build that already had one), or JIRA_ENABLED=1.
    // Without an opt-in, a build never touches Jira even if JIRA_* env vars are present
    // (so the platform does not have to strip them).
    const jiraOptIn =
      !!(options.jiraProject || this.state.jiraProject) ||
      /^(1|true|yes)$/i.test(process.env.JIRA_ENABLED || '');
    this.jiraEnabled = jiraOptIn && this.jira.isEnabled();
    if (this.jira.isEnabled() && !jiraOptIn) {
      console.log('[jira] Configured but not enabled for this build - pass --jira <project> or set JIRA_ENABLED=1 to opt in.');
    }
    this.github = createGitHubClient();
    this.github.workDir = this.workDir;
    if (options.noPush) this.github.noPush = true;
    if (options.noPr) this.github.noPr = true;

    // Persist base/feature into state on first use; on resume, restore from
    // state if not explicitly overridden by CLI flags. Without this, resume
    // forgets the gitflow target and tries to merge into "main".
    this.baseBranch = options.base ?? this.state.baseBranch;
    this.featureBranch = options.feature ?? this.state.featureBranch;
    if (options.base !== undefined) this.state.baseBranch = options.base;
    if (options.feature !== undefined) this.state.featureBranch = options.feature;
    if (this.state.baseBranch !== undefined || this.state.featureBranch !== undefined) {
      saveState(this.state);
    }
    if (this.baseBranch) this.github.baseBranch = this.baseBranch;
  }

  /**
   * The branch that phase branches branch off of, and merge back into.
   * - If `--feature` is set, phase work lands on the feature branch
   * - Else if `--base` is set, phase work lands on the base branch directly
   * - Else falls back to detected default (main/master)
   *
   * Established gitflow repos should pass `--base develop --feature feature/x`
   * so phase work lands on a feature branch and develop stays untouched.
   */
  private getMergeTarget(): string {
    return this.featureBranch ?? this.baseBranch ?? this.github.getDefaultBranch();
  }

  /**
   * Run the full orchestration loop
   */
  async run(description: string, options: OrchestratorOptions = {}): Promise<void> {
    this.log('='.repeat(60));
    this.log('TURKEYCODE - PHASE-BASED ORCHESTRATION');
    this.log('='.repeat(60));

    // Guard: turkeycode git-inits and writes files in the CURRENT directory. Running
    // in $HOME or a system root scatters a project across it (and `git add -A` chokes
    // on ~/Library permission walls). Refuse those and point the user at an empty folder.
    this.assertSafeWorkDir();

    // Preflight: verify Claude Code is available and working
    await this.preflightCheck();

    const isResume = this.state.currentPhase !== 'init' && this.state.projectDescription;
    audit(isResume ? 'orchestration_resumed' : 'orchestration_started', {
      details: { description, phase: this.state.currentPhase }
    });

    // Initialize state if new project
    if (this.state.currentPhase === 'init' || !this.state.projectDescription) {
      this.state = initState(description, {
        jiraProject: options.jiraProject,
        githubRepo: options.githubRepo,
        specFile: options.specFile
      });
      // initState replaced state with a fresh default — re-apply the
      // gitflow targets the constructor captured so they survive into
      // .turkey/state.json. Without this, resume forgets --feature/--base
      // and the merge step falls back to "main".
      if (this.baseBranch) this.state.baseBranch = this.baseBranch;
      if (this.featureBranch) this.state.featureBranch = this.featureBranch;
      if (this.state.baseBranch || this.state.featureBranch) saveState(this.state);
      this.log(`Initialized project: ${description}`);

      // Auto-setup GitHub repo if GITHUB_OWNER is set
      if (process.env.GITHUB_OWNER && this.github.isEnabled()) {
        const repoName = slugify(description);
        this.log(`Setting up GitHub repo: ${process.env.GITHUB_OWNER}/${repoName}`);
        this.github.setupProject(repoName, {
          private: true,
          description: description
        });
        this.state.githubRepo = `${process.env.GITHUB_OWNER}/${repoName}`;
        saveState(this.state);
      }

      // Auto-create Jira project if configured
      if (this.jiraEnabled) {
        const projectKey = await this.jira.ensureProject(description);
        if (projectKey) {
          this.state.jiraProject = projectKey;
          saveState(this.state);
          this.log(`Jira project ready: ${projectKey}`);
        }
      }
    }

    // Ensure feature branch exists if specified (branched off base).
    // Phase work will land on the feature branch; the base stays untouched.
    if (this.featureBranch) {
      const base = this.baseBranch ?? this.github.getDefaultBranch();
      this.github.ensureFeatureBranch(this.featureBranch, base);
      this.log(`Feature branch: ${this.featureBranch} (off ${base}) — base will not be modified`);
    } else if (this.baseBranch) {
      this.log(`Base branch override: ${this.baseBranch}`);
    }

    // ==================== DETECT PROJECT TYPE ====================
    // An explicit --type wins over auto-detection — essential for greenfield builds
    // (empty dir + spec), where the filesystem has nothing to detect from yet and
    // detection would otherwise default to web-fullstack (e.g. a COBOL build).
    // If the project is already complete, decide what a re-invocation means.
    // `run` (replanIfComplete) → the user wants NEW work from the provided spec, so re-plan a
    // fresh iteration (keep the code + context, clear phase tracking, regenerate the plan).
    // Without this, `turkeycode run --spec <new>` on a finished project silently no-ops and
    // prints "ORCHESTRATION COMPLETE" as if it built something. `resume` → report it as done.
    if (this.state.currentPhase === 'done') {
      if (options.replanIfComplete) {
        this.log('Project already complete — re-planning a new iteration from the provided spec.');
        this.state.projectDescription = description;
        this.state.buildPhases = [];
        this.state.completedPhases = [];
        this.state.currentBuildPhaseNumber = 1;
        this.state.currentPhase = 'research'; // continuation skips research; this re-triggers planning
        try {
          rmSync(join(this.workDir, PHASE_PLAN_FILE), { force: true });
          rmSync(join(this.workDir, PLAN_DONE), { force: true });
          // Clear prior-iteration phase tracking. The new iteration numbers its
          // phases 1..N again; if the old iteration's `.turkey/phases/phase-N/build.done`
          // markers survive, reconcileResumeState (and the build-skip check) false-match
          // the fresh phases against finished work — turkey then "completes" without
          // building anything. Removing the markers at replan time is the root-cause fix.
          rmSync(join(this.workDir, PHASES_DIR), { recursive: true, force: true });
        } catch { /* ignore */ }
        saveState(this.state);
      } else {
        this.log('Project already complete — nothing to resume. Run `turkeycode run --spec <file>` to add new work, or `turkeycode reset` to start over.');
        return;
      }
    }

    if (!this.state.projectType) {
      if (options.projectType) {
        this.state.projectType = options.projectType;
        this.log(`Project type (forced via --type): ${this.state.projectType}`);
      } else {
        // File-based detection, but WITHOUT the web-fullstack fallback — a greenfield
        // (empty) workspace returns 'unknown' here so we can read the real intent off
        // the description instead of blindly assuming a web app.
        const strictType = detectProjectTypeStrict(this.workDir);
        // Greenfield guard: a fresh "build me an app" request can land in a workspace that
        // happens to hold stray legacy files (e.g. leftover COBOL from a prior run/test).
        // Don't treat that as a legacy MODERNIZATION unless the request actually asks for one
        // — otherwise a greenfield app gets handed a mainframe strategy. An explicit
        // --type legacy still wins (handled above); this only overrides AUTO-detection.
        const wantsModernization =
          /\b(moderni[sz]|legacy|cobol|rpg|mainframe|jcl|pl\/?i|as\/?400|ibm\s*i|rewrite|re-?platform|port(ing)?|migrat)/i.test(
            description
          );
        // Greenfield = nothing concrete to detect ('unknown'), or only stray legacy files
        // with no modernization intent. Then the DESCRIPTION is the real signal: a "CLI"/
        // "terminal"/"API"/"desktop" build should not be mislabeled web-fullstack at start.
        const isGreenfield = strictType === 'unknown' || (strictType === 'legacy' && !wantsModernization);
        if (isGreenfield) {
          const inferred = inferProjectTypeFromDescription(description);
          this.state.projectType = inferred ?? 'web-fullstack';
          this.log(
            inferred
              ? `Greenfield build — project type inferred from description: ${this.state.projectType}`
              : `Greenfield build — no clear type in description; defaulting to web-fullstack.`
          );
        } else {
          this.state.projectType = strictType;
          this.log(`Detected project type: ${this.state.projectType}`);
        }
      }
      saveState(this.state);
    } else {
      this.log(`Project type: ${this.state.projectType}`);
    }

    // Ignore + untrack turkeycode's own state on the default branch BEFORE any phase
    // branch exists. .turkey/state.json mutates every phase; if it's ever git-tracked,
    // the phase-merge `git checkout` aborts ("local changes would be overwritten") and
    // the run dies. Doing it here (on main, once) keeps every branch free of it.
    // Guarantee a local git repo with a BORN default branch exists before any
    // phase branching — even without a GitHub remote (GITHUB_OWNER unset, e.g.
    // headless/CI builds). `git init -b main` leaves main unborn until the first
    // commit, so the first phase's `git checkout main` would otherwise fail and
    // branch reconciliation breaks. (With GITHUB_OWNER, setupProject already
    // inited + committed; initRepo/ensureInitialCommit are no-ops then.)
    this.github.initRepo();
    this.ensureGitignore();
    try {
      if (this.github.hasUncommittedChanges()) {
        this.github.commit('chore: ignore turkeycode runtime state (.turkey/)');
      }
    } catch { /* no repo yet / nothing to commit — fine */ }
    this.github.ensureInitialCommit();

    // Load spec file content if provided. Auto-detect when the description is
    // itself a path to a markdown file — `turkeycode run my-prompt.md` should
    // Just Work without requiring `--spec`.
    let specContent: string | undefined;
    let resolvedSpecFile: string | undefined = options.specFile;
    if (!resolvedSpecFile && /\.(md|txt)$/i.test(description) && existsSync(description)) {
      resolvedSpecFile = description;
      this.log(`Auto-detected spec file from description: ${description}`);
    }
    if (resolvedSpecFile && existsSync(resolvedSpecFile)) {
      specContent = readFileSync(resolvedSpecFile, 'utf-8');
    }

    // Detect if this is a continuation sprint (workspace already has code)
    const isFirstSprint = !existsSync('package.json') && !existsSync('Dockerfile');

    if (isFirstSprint) {
      // ==================== RESEARCH PHASE (greenfield only) ====================
      // Research agent reads the spec, surveys the stack, and writes SPECS_FILE.
      if (this.state.currentPhase === 'init' || this.state.currentPhase === 'research') {
        await this.runResearch(specContent);
      }
    } else {
      // ==================== ITERATE: skip research, seed SPECS_FILE directly ====================
      // Code already exists, so the planner can read it directly — no research agent needed.
      // But the plan prompt reads SPECS_FILE, so write the user's spec there verbatim.
      this.log('Continuation sprint detected — skipping research, planning from spec');
      // Don't clobber a human-confirmed scope spec: if `turkeycode scope` already
      // produced specs.md and the user didn't pass a fresh --spec, keep the scoped one.
      const scoped = existsSync(SCOPE_DONE) && existsSync(SPECS_FILE);
      if (scoped && !specContent) {
        this.log('Scoped spec detected — planning from it (not overwriting).');
      } else if (specContent || description) {
        if (!existsSync(REFERENCE_DIR)) {
          mkdirSync(REFERENCE_DIR, { recursive: true });
        }
        writeFileSync(SPECS_FILE, specContent || description, 'utf-8');
      }
      if (this.state.currentPhase === 'init' || this.state.currentPhase === 'research') {
        this.state.currentPhase = 'research';
        saveState(this.state);
      }
    }

    // ==================== PLAN PHASE (always) ====================
    if (this.state.currentPhase === 'research' || this.state.currentPhase === 'plan') {
      await this.runPlan(!isFirstSprint);
    }

    // Load phase plan — gracefully handle missing file on resume
    const plan = loadPhasePlan();
    if (!plan) {
      if (this.state.buildPhases.length > 0) {
        this.log('Phase plan file missing but build phases exist in state, continuing...');
      } else {
        this.log('Phase plan missing — re-running plan phase...');
        await this.runPlan(!isFirstSprint);
        const retryPlan = loadPhasePlan();
        if (!retryPlan) {
          this.log('ERROR: Failed to generate phase plan after retry');
          process.exit(1);
        }
        this.state.buildPhases = retryPlan.phases;
      }
    } else {
      if (this.state.buildPhases.length > 0) {
        for (const planPhase of plan.phases) {
          const existing = this.state.buildPhases.find(p => p.number === planPhase.number);
          if (existing) {
            Object.assign(existing, {
              ...planPhase,
              jiraTicketKey: existing.jiraTicketKey || planPhase.jiraTicketKey,
              prNumber: existing.prNumber || planPhase.prNumber,
              branchName: existing.branchName || planPhase.branchName,
              status: existing.status !== 'planned' ? existing.status : planPhase.status,
              buildAttempts: existing.buildAttempts || planPhase.buildAttempts,
              qaAttempts: existing.qaAttempts || planPhase.qaAttempts,
              lastQaVerdict: existing.lastQaVerdict || planPhase.lastQaVerdict,
              startedAt: existing.startedAt || planPhase.startedAt,
              completedAt: existing.completedAt || planPhase.completedAt,
            });
          }
        }
      } else {
        this.state.buildPhases = plan.phases;
      }
    }

    if (this.state.currentBuildPhaseNumber === 0) {
      this.state.currentBuildPhaseNumber = 1;
    }
    saveState(this.state);

    // ==================== RESUME RECONCILIATION ====================
    // If a previous run died between a git mutation and the state save (e.g.
    // after merging a phase branch to main but before persisting status='done'),
    // state and filesystem disagree. Reconcile by scanning non-done phases
    // whose artifacts indicate they already completed on disk.
    if (isResume) {
      this.reconcileResumeState();
    }

    // ==================== PHASE LOOP ====================
    while (this.state.currentBuildPhaseNumber <= this.state.buildPhases.length) {
      await this.runBuildPhase();

      // Check if there are more phases
      if (!advancePhase(this.state)) {
        break;
      }
      saveState(this.state);
    }

    // ==================== POLISH PASS (defer-warnings model) ====================
    // Per-phase QA gated on blockers only, so warnings accumulated across phases.
    // One repo-wide pass cleans them coherently, then we re-verify the build.
    // (An already-complete project is intercepted earlier, so currentPhase is never 'done' here.)
    if (this.polish) {
      await this.runPolishPhase();
    }

    // Return the working tree to the default branch — phase merges and the polish pass switch
    // branches internally, and some paths (e.g. a clean polish pass with nothing to merge) can
    // otherwise leave the user checked out on a phase/polish branch after the run completes.
    try {
      const finalBranch = this.github.getDefaultBranch();
      if (this.github.getCurrentBranch() !== finalBranch) {
        this.github.checkoutBranch(finalBranch);
        this.log(`Returned working tree to ${finalBranch}`);
      }
    } catch { /* best effort — never fail the run over this */ }

    // ==================== DONE ====================
    this.state.currentPhase = 'done';
    saveState(this.state);

    audit('orchestration_completed', {
      details: {
        phases: this.state.completedPhases.length
      }
    });

    this.log('='.repeat(60));
    this.log('ORCHESTRATION COMPLETE');
    this.log('='.repeat(60));
    this.log('');
    this.log('🦃 Your project is ready! Here\'s what you can do next:');
    this.log('');
    this.log('  Run locally (Docker):');
    this.log('    turkeycode run-local');
    this.log('');
    this.log('  Deploy to turkeycode.ai:');
    this.log('    turkeycode login');
    this.log('    turkeycode deploy');
    this.log('');
    this.log('  Iterate — add features or fix bugs:');
    this.log('    turkeycode run "add dark mode and user profiles"');
    this.log('');
    this.log('  Or just run it yourself — check the README for setup instructions.');
  }

  /**
   * Run research phase
   */
  private async runResearch(specContent?: string): Promise<void> {
    this.log('\n=== PHASE: RESEARCH ===\n');
    auditPhase('research', 'started');
    this.state.currentPhase = 'research';
    this.state.currentStep = 'research';
    saveState(this.state);

    // Check if research already done
    const gateResult = this.gates.checkResearch();
    if (gateResult.passed) {
      this.log('Research gate already passes, skipping...');
      auditPhase('research', 'completed', { skipped: true });
      return;
    }

    // Scoped mode: a human already confirmed the intent spec via `turkeycode scope`.
    // Research then runs in augment mode — it adds a technical survey without
    // overwriting the human's confirmed Description/Features/Flows.
    const scoped = existsSync(SCOPE_DONE) && existsSync(SPECS_FILE);
    if (scoped) {
      this.log('Scoped spec detected — research will augment (not overwrite) it.');
    }

    // Spawn research agent
    const prompt = buildResearchPrompt(this.state, specContent, scoped);
    const result = await this.spawner.run({
      cwd: this.workDir,
      prompt,
      timeoutMs: RESEARCH_TIMEOUT_MS,
      sessionName: 'research',
      doneFile: RESEARCH_DONE,
      model: getModelForPhase('research')
    });

    if (result.exitCode !== 0) {
      this.log(`Research session exited with code ${result.exitCode}`);
    }

    // Check gate
    const finalGate = this.gates.checkResearch();
    auditGate('research', finalGate.passed);
    enforceGate(finalGate);
    auditPhase('research', 'completed', { durationMs: result.durationMs });
  }

  /**
   * Run plan phase - single session produces phase-plan.json
   */
  /**
   * Detect whether the spec contains a numbered ticket list (e.g. `#14`, `#35`, ...).
   * Heuristic: 5+ lines beginning with a `#NN` or `NN.` pattern within the spec.
   * When true, the planner is told to emit one sprint per ticket.
   */
  private detectTicketList(): boolean {
    if (!existsSync(SPECS_FILE)) return false;
    try {
      const text = readFileSync(SPECS_FILE, 'utf-8');
      // Match lines like "  #14   Impact aspect" or "- #14 Impact" or "14. Foo"
      const ticketLines = text.split('\n').filter(line =>
        /^\s*[-*]?\s*#\d+\b/.test(line) || /^\s*\d{1,4}\.\s+\S/.test(line)
      );
      return ticketLines.length >= 5;
    } catch {
      return false;
    }
  }

  private async runPlan(isIterate: boolean = false): Promise<void> {
    this.log('\n=== PHASE: PLAN ===\n');
    auditPhase('plan', 'started');
    this.state.currentPhase = 'plan';
    this.state.currentStep = 'plan';
    saveState(this.state);

    // Check if plan already done
    const gateResult = this.gates.checkPlan();
    if (gateResult.passed) {
      this.log('Plan gate already passes, skipping...');
      auditPhase('plan', 'completed', { skipped: true });
      return;
    }

    // Single planning session
    const hasTicketList = this.detectTicketList();
    if (hasTicketList) {
      this.log('Spec contains a numbered ticket list — planning in TICKET-LIST mode (one sprint per ticket)');
    }
    const prompt = buildPlanPrompt(this.state, isIterate, hasTicketList);
    const result = await this.spawner.run({
      cwd: this.workDir,
      prompt,
      timeoutMs: PLAN_TIMEOUT_MS,
      sessionName: 'plan',
      doneFile: PLAN_DONE,
      model: getModelForPhase('plan')
    });

    if (result.exitCode !== 0) {
      this.log(`Plan session exited with code ${result.exitCode}`);
    }

    // Check gate
    const finalGate = this.gates.checkPlan();
    auditGate('plan', finalGate.passed);
    enforceGate(finalGate);
    auditPhase('plan', 'completed', { durationMs: result.durationMs });
  }

  /**
   * Reconcile state.json with filesystem truth at the start of a resume.
   *
   * State saves are not atomic with git mutations. If a previous run was
   * killed between (e.g.) merging a phase branch to the default branch and
   * the subsequent `saveState` marking the phase done, state.json says the
   * phase is still 'building'/'qa'/'merging' while git has already moved on.
   *
   * This reconcile pass walks every non-done phase and checks if its
   * deliverables are already present on the default branch. If they are —
   * identified by a commit subject matching `phase-<N>:` reachable from the
   * default branch HEAD plus the phase's `build.done` artifact — we mark
   * the phase done and advance state past it. This makes resume idempotent
   * and prevents the failure mode where turkey re-creates a phase branch
   * off a main that already contains the work, producing an empty diff that
   * QA's provenance check then flags as a critical blocker.
   */
  private reconcileResumeState(): void {
    let defaultBranch: string;
    try {
      defaultBranch = this.getMergeTarget();
    } catch {
      return;
    }

    let advanced = 0;
    for (const phase of this.state.buildPhases) {
      if (phase.status === 'done') continue;

      const buildDonePath = join(this.workDir, PHASES_DIR, `phase-${phase.number}`, 'build.done');
      if (!existsSync(buildDonePath)) continue;

      // Defense-in-depth (mirrors the build-skip guard): a build.done older than
      // phase-plan.json belongs to a prior iteration's phase of the same number.
      if (isBuildDoneStale(this.workDir, buildDonePath)) {
        this.log(
          `Reconcile: phase ${phase.number} build.done is stale (older than phase-plan.json) — skipping`
        );
        continue;
      }

      // Does a commit for this phase's work exist on the default branch?
      let phaseCommitOnDefault = false;
      try {
        const out = execSync(
          `git log ${defaultBranch} --grep="^phase-${phase.number}:" --format=%H -n 1`,
          { cwd: this.workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        phaseCommitOnDefault = out.length > 0;
      } catch {
        phaseCommitOnDefault = false;
      }
      if (!phaseCommitOnDefault) continue;

      this.log(
        `Reconcile: phase ${phase.number} (status=${phase.status}) has build.done and a phase-${phase.number}: commit on ${defaultBranch} — marking done`
      );
      phase.status = 'done';
      if (!phase.completedAt) phase.completedAt = new Date().toISOString();

      if (!this.state.completedPhases.find(p => p.number === phase.number)) {
        this.state.completedPhases.push({
          number: phase.number,
          name: phase.name,
          completedAt: phase.completedAt,
          buildTime: phase.buildTime || '',
          prNumber: phase.prNumber,
          aarPath: `docs/aar/phase-${phase.number}.md`
        });
      }
      advanced++;
    }

    // Advance the phase pointer past any run of now-done phases.
    while (
      this.state.currentBuildPhaseNumber <= this.state.buildPhases.length &&
      this.state.buildPhases.find(p => p.number === this.state.currentBuildPhaseNumber)?.status === 'done'
    ) {
      this.state.currentBuildPhaseNumber++;
      this.state.qaAttempts = 0;
      this.state.lastQaVerdict = undefined;
      this.state.lastQaFindings = undefined;
    }

    if (advanced > 0) {
      this.log(`Reconcile: advanced ${advanced} phase(s) to done; resuming at phase ${this.state.currentBuildPhaseNumber}`);
      saveState(this.state);
    }
  }

  /**
   * Run a complete build phase:
   * build → quick check → QA → fix loop → code review → AAR → merge
   */
  private async runBuildPhase(): Promise<void> {
    const phaseNumber = this.state.currentBuildPhaseNumber;
    const phase = this.state.buildPhases.find(p => p.number === phaseNumber);

    if (!phase) {
      this.log(`ERROR: Phase ${phaseNumber} not found`);
      process.exit(1);
      return; // TypeScript flow
    }

    this.log('\n' + '='.repeat(60));
    this.log(`BUILD PHASE ${phaseNumber}: ${phase.name}`);
    this.log('='.repeat(60));

    auditBuildPhase(phaseNumber, 'started', { name: phase.name });
    phase.startedAt = new Date().toISOString();
    phase.status = 'building';
    saveState(this.state);

    // Create or reuse Jira ticket for phase
    let jiraTicketKey: string | null = phase.jiraTicketKey || null;
    if (!jiraTicketKey && this.jiraEnabled) {
      const deliverables = phase.deliverables.map(d => `- ${d}`).join('\n');
      jiraTicketKey = await this.jira.createTicket({
        summary: `Phase ${phaseNumber}: ${phase.name}`,
        description: `Scope: ${phase.scope}\n\nDeliverables:\n${deliverables}`,
        issueType: 'Story'
      });
      if (jiraTicketKey) {
        phase.jiraTicketKey = jiraTicketKey;
        saveState(this.state);
        this.log(`Jira ticket created: ${jiraTicketKey}`);
        await this.jira.transitionTicket(jiraTicketKey, 'In Progress');
      }
    } else if (jiraTicketKey) {
      this.log(`Reusing Jira ticket: ${jiraTicketKey}`);
      await this.jira.transitionTicket(jiraTicketKey, 'In Progress');
    }

    // Create phase branch off the merge target (feature branch if set,
    // else base branch if set, else detected default).
    const phaseBranch = `phase-${phaseNumber}/${slugify(phase.name)}`;
    phase.branchName = phaseBranch;
    const defaultBranch = this.getMergeTarget();
    this.github.createBranch(phaseBranch, defaultBranch);

    // Ensure .gitignore exists (prevents node_modules/.next etc from being committed)
    this.ensureGitignore();

    // ==================== BUILD ====================
    // Only skip build if THIS phase has actually been built (check for build.done artifact)
    // Guard: if phase-plan.json is newer than build.done, the plan was regenerated and build.done is stale
    const buildDonePath = join(this.workDir, PHASES_DIR, `phase-${phaseNumber}`, 'build.done');
    let phaseAlreadyBuilt = existsSync(buildDonePath);
    if (phaseAlreadyBuilt && isBuildDoneStale(this.workDir, buildDonePath)) {
      this.log(`Phase ${phaseNumber} build.done is stale (older than phase-plan.json), removing...`);
      try { unlinkSync(buildDonePath); } catch { /* ignore */ }
      phaseAlreadyBuilt = false;
    }
    if (phaseAlreadyBuilt) {
      this.log(`Phase ${phaseNumber} already built (build.done exists), skipping build...`);
    } else {
      this.state.currentPhase = 'build';
      saveState(this.state);

      // Snapshot branches before build so we can detect any sub-branches the
      // agent creates during the session (specs sometimes instruct branch-per-ticket).
      const branchesBefore = this.github.listLocalBranches();

      await this.runPhaseBuild(phase, phaseBranch);

      // Reconcile any sub-branches the build agent created back onto the phase branch.
      const recon = this.github.reconcileSubBranches(phaseBranch, branchesBefore);
      if (recon.reconciled.length > 0) {
        this.log(`Branch reconciliation: cherry-picked ${recon.reconciled.length} sub-branch(es) onto ${phaseBranch}: ${recon.reconciled.join(', ')}`);
      }
      if (recon.failed.length > 0) {
        this.log(`ERROR: Branch reconciliation failed for: ${recon.failed.join(', ')}. These branches contain commits that could not be cherry-picked onto the phase branch (likely conflicts). Phase cannot proceed without manual intervention.`);
        saveState(this.state);
        process.exit(1);
      }
    }

    // Safety net: if the build agent staged files but forgot to commit (a known
    // failure mode), commit them now. Without this, the QA diff check sees an
    // empty branch, correctly flags "missing deliverables," and the phase fails
    // after max attempts with all the work sitting in the index.
    if (this.github.hasUncommittedChanges()) {
      this.log(`Build agent left uncommitted changes — committing as safety net`);
      this.github.commit(`phase-${phaseNumber}: ${phase.name}`);
    }

    // Create PR for phase (reuse existing if found) — skip if no remote
    if (this.github.hasRemote()) {
      if (!phase.prNumber) {
        const existingPR = this.github.findExistingPR(phaseBranch);
        if (existingPR) {
          phase.prNumber = existingPR;
          this.log(`Reusing existing PR #${existingPR} for ${phaseBranch}`);
        } else {
          const newPR = this.github.createPR({
            title: `Phase ${phaseNumber}: ${phase.name}`,
            body: this.generatePRBody(phase),
            base: defaultBranch,
            head: phaseBranch
          });
          if (newPR) {
            phase.prNumber = newPR;
          }
        }
      } else {
        this.log(`Reusing existing PR #${phase.prNumber} for ${phaseBranch}`);
      }
    } else {
      this.log(`Skipping PR creation (no remote configured)`);
    }

    // Mark build complete — quick-check and QA can resume without rebuilding
    this.state.currentPhase = 'quick-check';
    saveState(this.state);

    // ==================== QUICK SMOKE CHECK ====================
    await this.runQuickSmokeCheck(phaseNumber);

    // ==================== QA PHASE ====================
    phase.status = 'qa';
    this.state.currentPhase = 'qa';
    saveState(this.state);
    if (jiraTicketKey) {
      await this.jira.addComment(jiraTicketKey, `Build complete. Starting QA (attempt ${phase.qaAttempts + 1}).`);
    }
    await this.runQAFast(phaseNumber);

    // ==================== CODE REVIEW ====================
    // Runs on the QA-passed code, before merge. Produces reviews/phase-N.md and
    // hard-gates on that artifact existing (the documented flow:
    // QA → code review → AAR → merge). Unlike AAR this is not opt-in — it's a
    // standard phase gate.
    await this.runCodeReview(phaseNumber);

    // ==================== AAR PHASE (opt-in) ====================
    // Off by default: the report is write-only (no downstream prompt reads it,
    // and QA is told to distrust it), so it's pure cost + a failure surface.
    // Enable with `--aar` when a human wants the per-phase markdown summary.
    // When enabled, failures here are hard gates — docs/aar/phase-N.md MUST exist.
    if (this.aar) {
      await this.runAAR(phaseNumber);
    } else {
      this.log('Skipping AAR (disabled — pass --aar to generate per-phase reports)');
    }

    // Commit any uncommitted changes
    if (this.github.hasUncommittedChanges()) {
      this.log(`Committing uncommitted changes before merge...`);
      this.github.commit(`chore: commit remaining changes for phase ${phaseNumber}`);
      if (phase.prNumber) {
        this.github.push(phaseBranch);
      }
    }

    // Re-read merge target right before merge (repo now guaranteed to exist).
    // Honors --base / --feature; falls back to detected default branch.
    const mergeTarget = this.getMergeTarget();

    // Check if the phase branch actually exists (createBranch may have failed silently)
    const currentBranch = this.github.getCurrentBranch();
    const phaseBranchExists = this.github.branchExists(phaseBranch);

    // Record intent-to-merge *before* the git mutation. If the process dies
    // between the actual merge and the final saveState below, reconcileResumeState
    // uses this marker (plus the on-disk git state) to detect that the phase
    // completed and advance state accordingly.
    phase.status = 'merging';
    saveState(this.state);

    let merged = false;
    if (!phaseBranchExists) {
      // Code was built directly on the default branch — no merge needed
      this.log(`Phase branch '${phaseBranch}' not found — code is already on '${currentBranch}'. Skipping merge.`);
      merged = true;
    } else if (phase.prNumber) {
      merged = this.github.mergePR(phase.prNumber);
      if (!merged) {
        this.log(`PR merge failed for #${phase.prNumber}, falling back to local merge...`);
        merged = await this.mergeWithResolution(phaseNumber, phaseBranch, mergeTarget);
        if (merged && this.github.hasRemote()) {
          this.github.push(mergeTarget);
        }
      }
    } else {
      // No PR (no remote) — merge locally
      this.log(`Merging ${phaseBranch} into ${mergeTarget} locally (no PR)`);
      merged = await this.mergeWithResolution(phaseNumber, phaseBranch, mergeTarget);
    }

    if (!merged) {
      this.log(`ERROR: Failed to merge ${phaseBranch} into ${mergeTarget}. Cannot proceed to next phase.`);
      process.exit(1);
    }

    phase.status = 'done';
    phase.completedAt = new Date().toISOString();
    saveState(this.state);

    // Close Jira ticket
    if (jiraTicketKey) {
      await this.jira.closeTicket(jiraTicketKey, phase.prNumber || undefined);
    }

    auditBuildPhase(phaseNumber, 'completed', {
      name: phase.name,
      prNumber: phase.prNumber,
      jiraTicket: jiraTicketKey
    });
  }

  /**
   * Run the build session for a phase - one session builds everything
   */
  private async runPhaseBuild(phase: BuildPhase, phaseBranch: string): Promise<void> {
    this.log(`\n--- Building Phase ${phase.number}: ${phase.name} ---`);

    // Build prompt and run session
    const prompt = buildBuildPhasePrompt(this.state, phase);
    const buildDoneFile = `${PHASES_DIR}/phase-${phase.number}/build.done`;
    const startTime = Date.now();

    // Local retry loop: up to MAX_BUILD_RETRIES build sessions PER invocation.
    // The retry decision is gated on `localAttempt`, NOT the persisted
    // `phase.buildAttempts`. That counter accumulates across resumes, so gating on
    // it starved a resumed phase of retries (it would run once, see the counter
    // already at the cap, and exit without the retry the constant promises).
    let result!: SpawnResult;
    let gateResult = this.gates.checkPhaseBuild(phase.number);
    for (let localAttempt = 0; localAttempt < MAX_BUILD_RETRIES; localAttempt++) {
      phase.buildAttempts = (phase.buildAttempts || 0) + 1;
      saveState(this.state);

      if (localAttempt > 0) {
        this.log(`Build gate failed for phase ${phase.number}, retrying (${localAttempt + 1}/${MAX_BUILD_RETRIES})...`);
      }

      result = await this.spawner.run({
        cwd: this.workDir,
        prompt,
        timeoutMs: PHASE_BUILD_TIMEOUT_MS,
        sessionName: localAttempt === 0 ? `build-phase-${phase.number}` : `build-phase-${phase.number}-retry`,
        doneFile: buildDoneFile,
        model: getModelForPhase('build')
      });

      gateResult = this.gates.checkPhaseBuild(phase.number);
      if (gateResult.passed) break;
    }

    phase.buildTime = this.formatDuration(Date.now() - startTime);
    saveState(this.state);

    if (!gateResult.passed) {
      // Better diagnostics for short output (common failure mode)
      if (result.stdout.length < 1000) {
        this.log(`\n⚠️  Build output was suspiciously short (${result.stdout.length} chars).`);
        this.log(`This usually means Claude Code didn't execute the build properly.`);
        this.log(`\nClaude output:\n${result.stdout.substring(0, 2000)}`);
        if (result.stderr.length > 0) {
          this.log(`\nStderr:\n${result.stderr.substring(0, 1000)}`);
        }
        this.log(`\nTroubleshooting:`);
        this.log(`1. Run "claude --print 'hello'" to verify Claude Code works`);
        this.log(`2. Check your Claude subscription is active`);
        this.log(`3. Try running with a different model: turkeycode run --model opus "..."`);
      }
      enforceGate(gateResult); // Will exit(1)
    }

    // Commit and push
    this.github.commit(`phase-${phase.number}: ${phase.name}`);
    this.github.push(phaseBranch);

    this.log(`Phase ${phase.number} built in ${phase.buildTime}`);
  }

  /**
   * Run quick smoke check before expensive QA
   */
  private async runQuickSmokeCheck(phaseNumber: number): Promise<void> {
    const MAX_QUICK_FIX_ATTEMPTS = 2;

    for (let attempt = 0; attempt <= MAX_QUICK_FIX_ATTEMPTS; attempt++) {
      this.log(`\n=== QUICK SMOKE CHECK (pre-QA)${attempt > 0 ? ` — retry ${attempt}/${MAX_QUICK_FIX_ATTEMPTS}` : ''} ===\n`);
      this.log('Running fast validation before expensive QA...');

      const result = await runQuickChecks(this.workDir);

      // Log results
      for (const check of result.checks) {
        const status = check.passed ? '✓' : '✗';
        this.log(`  ${status} ${check.name}: ${check.message} (${check.duration}ms)`);
      }

      this.log(`\nQuick check completed in ${result.duration}ms`);

      if (result.passed) {
        this.log('=== QUICK SMOKE CHECK PASSED ===\n');
        audit('gate_passed', { gate: 'quick-smoke-check', details: { duration: result.duration } });
        return;
      }

      // Write failure details
      const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
      if (!existsSync(qaDir)) {
        mkdirSync(qaDir, { recursive: true });
      }
      const quickVerdictPath = `${qaDir}/quick-check-failed.json`;
      writeFileSync(quickVerdictPath, JSON.stringify({
        verdict: 'BLOCKED',
        timestamp: new Date().toISOString(),
        phase: phaseNumber,
        attempt,
        checks: result.checks,
        duration: result.duration,
        message: 'Quick smoke check failed'
      }, null, 2));

      audit('gate_failed', { gate: 'quick-smoke-check', details: { attempt, checks: result.checks } });

      // If we've exhausted fix attempts, hard fail
      if (attempt >= MAX_QUICK_FIX_ATTEMPTS) {
        this.log('\n=== QUICK SMOKE CHECK FAILED (max fix attempts reached) ===');
        this.log('Could not auto-fix the issues. Manual intervention required.\n');
        process.exit(1);
      }

      // Spawn a fix agent to address the failures
      this.log('\n=== SPAWNING FIX AGENT FOR QUICK-CHECK FAILURES ===\n');

      const failures = result.checks
        .filter(c => !c.passed)
        .map(c => `- ${c.name}: ${c.message}`)
        .join('\n');

      const phase = this.state.buildPhases.find(p => p.number === phaseNumber);
      const fixPrompt = `You are fixing quick-check failures for Phase ${phaseNumber}: ${phase?.name || 'unknown'}.

The following quick smoke checks FAILED:

${failures}

Your job:
1. Read the error messages carefully
2. Find the root cause of each failure
3. Fix the code so these checks pass
4. Commit your fixes

IMPORTANT:
- These are build/compile/start failures, not QA issues
- Focus on making the code compile and the server start
- Do NOT change the quick-check tooling itself — fix the project code
- Work in the current directory: ${this.workDir}

When done, create a file: ${qaDir}/quick-fix-${attempt}.done`;

      const fixResult = await this.spawner.run({
        cwd: this.workDir,
        prompt: fixPrompt,
        timeoutMs: FIX_TIMEOUT_MS,
        sessionName: `quick-fix-${attempt}`,
        doneFile: `${qaDir}/quick-fix-${attempt}.done`,
        model: getModelForPhase('quick-fix')
      });

      if (fixResult.exitCode !== 0) {
        this.log(`Quick-fix session exited with code ${fixResult.exitCode}`);
      }

      this.log('Fix agent completed. Re-running quick checks...\n');
    }
  }

  /**
   * v3-fast: Combined QA — single session does smoke + functional + verdict.
   * Replaces the 4-agent carousel with 1 QA session + 1 fix session per attempt.
   * Max 3 attempts (vs 5 for the old flow).
   */
  private async runQAFast(phaseNumber: number): Promise<void> {
    this.log('\n=== PHASE: QA (FAST MODE) ===\n');
    auditPhase('qa', 'started', { buildPhase: phaseNumber, mode: 'fast' });
    this.state.currentPhase = 'qa';

    const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
    // Clean stale QA artifacts
    if (existsSync(qaDir)) {
      const files = readdirSync(qaDir);
      for (const file of files) {
        if (file.endsWith('.done') || file.endsWith('.json') || file.endsWith('.md')) {
          unlinkSync(join(qaDir, file));
        }
      }
    }
    if (!existsSync(qaDir)) {
      mkdirSync(qaDir, { recursive: true });
    }
    // Clean stale screenshots so the visual pass captures this phase fresh
    const screenshotsDir = `${SCREENSHOTS_DIR}/phase-${phaseNumber}`;
    if (existsSync(screenshotsDir)) {
      rmSync(screenshotsDir, { recursive: true, force: true });
    }

    this.state.qaAttempts = 0;
    saveState(this.state);

    const MAX_FAST_QA_ATTEMPTS = 3;
    let qaPass = false;
    let preFixSha: string | null = null;
    let prevBlockerCount: number | null = null;
    let rateLimitRetries = 0;

    while (!qaPass && this.state.qaAttempts < MAX_FAST_QA_ATTEMPTS) {
      this.state.qaAttempts++;
      const attempt = this.state.qaAttempts;
      saveState(this.state);

      this.log(`\n--- QA Attempt ${attempt}/${MAX_FAST_QA_ATTEMPTS} (combined session) ---\n`);
      auditQA(phaseNumber, attempt, 'started');

      // Capture git diff stat vs the phase's merge target so the verdict agent can
      // ground-check whether the work claimed actually landed. Without this, QA
      // happily passes a 14-ticket "all done" claim against an empty diff.
      const baseRef = this.getMergeTarget();
      let diffStat = '';
      try {
        diffStat = execSync(`git diff ${baseRef}...HEAD --stat`, { encoding: 'utf-8' }).trim();
      } catch { /* base branch may not exist on first run */ }

      // Combined QA session (smoke + functional + verdict) runs alongside a
      // dedicated visual QA session (screenshots + blind fresh-context review).
      // Visual is the secret sauce: a fresh agent that never saw the code judges
      // the rendered UI from screenshots, with cross-attempt memory. It's skipped
      // for non-visual project types (CLI/API/library/embedded).
      const skipVisual = shouldSkipVisualQA(this.state.projectType || 'web-fullstack');
      const qaTasks = [
        {
          cwd: this.workDir,
          prompt: buildQaCombinedPrompt(this.state, phaseNumber, attempt, diffStat, baseRef),
          timeoutMs: QA_TIMEOUT_MS,
          sessionName: `qa-combined-${attempt}`,
          doneFile: `${QA_DIR}/phase-${phaseNumber}/verdict-${attempt}.done`,
          model: getModelForPhase('qa-functional') // Sonnet for combined QA
        }
      ];
      if (skipVisual) {
        this.log(`Skipping visual QA — project type "${this.state.projectType}" has no visual surface`);
      } else {
        this.log('--- Running combined QA + visual QA (parallel) ---');
        qaTasks.push({
          cwd: this.workDir,
          prompt: buildQaVisualPrompt(this.state, phaseNumber, attempt),
          timeoutMs: QA_TIMEOUT_MS,
          sessionName: `qa-visual-${attempt}`,
          doneFile: `${QA_DIR}/phase-${phaseNumber}/visual-${attempt}.done`,
          model: getModelForPhase('qa-visual')
        });
      }

      const qaResults = await this.spawner.runParallel(qaTasks, skipVisual ? 1 : 2);

      this.assertNotCreditExhausted(qaResults);
      if (qaResults.some(r => r.rateLimited)) {
        rateLimitRetries = await this.waitForRateLimit(rateLimitRetries, 'QA');
        this.state.qaAttempts--;
        saveState(this.state);
        continue;
      }

      // Fallback: if verdict file wasn't created, create one
      const verdictPath = `${qaDir}/verdict-${attempt}.json`;
      if (!existsSync(verdictPath)) {
        await new Promise(r => setTimeout(r, 5000)); // Wait for file writes
        if (!existsSync(verdictPath)) {
          this.log('Verdict file not created, creating fallback...');
          this.createFallbackVerdict(qaDir, phaseNumber, attempt);
        }
      }

      // Fold the visual pass's findings into the verdict so its blockers gate the
      // phase exactly like functional blockers (and reach the fix agent).
      if (!skipVisual) {
        this.mergeVisualFindings(qaDir, phaseNumber, attempt);
      }

      // Check verdict
      const verdictGate = this.gates.checkQaVerdict(phaseNumber, attempt);
      auditGate(`qa-verdict-${attempt}`, verdictGate.passed);

      if (verdictGate.passed) {
        this.log('QA PASSED — verdict is CLEAN');
        qaPass = true;
        this.state.lastQaVerdict = 'CLEAN';
        auditQA(phaseNumber, attempt, 'passed');
      } else {
        this.log(`QA FAILED — ${verdictGate.message}`);
        this.state.lastQaVerdict = 'NEEDS_FIX';
        auditQA(phaseNumber, attempt, 'failed', { message: verdictGate.message });

        const currentBlockers = this.getBlockerCount(qaDir, attempt);

        // Check if previous fix made things worse — revert if so
        let reverted = false;
        if (preFixSha && prevBlockerCount !== null && currentBlockers > prevBlockerCount) {
          this.log(`⚠ FIX REGRESSION: ${prevBlockerCount} → ${currentBlockers} blockers. Reverting...`);
          try {
            execSync(`git reset --hard ${preFixSha}`, { cwd: this.workDir, stdio: 'pipe' });
            this.log(`Reverted to ${preFixSha.slice(0, 8)}`);
            reverted = true;
          } catch (err) {
            this.log(`Failed to revert: ${err}`);
          }
        }

        // Warnings-only acceptance after 2 attempts
        const warningsOnly = this.isWarningsOnly(qaDir, attempt);
        if (warningsOnly && this.state.qaAttempts >= 2) {
          this.log(`Only warnings remain after ${this.state.qaAttempts} attempts — accepting`);
          qaPass = true;
          this.state.lastQaVerdict = 'CLEAN';
          auditQA(phaseNumber, attempt, 'passed', { note: 'warnings-only acceptance' });
          break;
        }

        // Run fix session if not last attempt
        if (this.state.qaAttempts < MAX_FAST_QA_ATTEMPTS) {
          preFixSha = this.getGitHead();
          prevBlockerCount = reverted ? prevBlockerCount : currentBlockers;

          this.log(`\n--- Fix Session (attempt ${attempt}) ---\n`);
          await this.spawner.run({
            cwd: this.workDir,
            prompt: buildQaFixPrompt(this.state, phaseNumber, attempt),
            timeoutMs: FIX_TIMEOUT_MS,
            sessionName: `qa-fix-${attempt}`,
            doneFile: `${QA_DIR}/phase-${phaseNumber}/fix-${attempt}.done`,
            model: getModelForPhase('qa-fix') // Opus for fixes
          });

          // Commit fixes
          const phase = this.state.buildPhases.find(p => p.number === phaseNumber);
          this.github.commit(`fix: QA attempt ${attempt} fixes`);
          if (phase?.branchName) {
            this.github.push(phase.branchName);
          }

          // No-op guard: if the fix edited nothing, re-running QA is pointless.
          if (this.fixWasNoop(preFixSha, attempt)) {
            saveState(this.state);
            break;
          }
        }
      }

      saveState(this.state);
    }

    if (!qaPass) {
      this.log('QA FAILED after maximum attempts');
      auditPhase('qa', 'completed', { passed: false, attempts: this.state.qaAttempts });
      process.exit(75); // QA exhausted exit code
    }

    auditPhase('qa', 'completed', { passed: true, attempts: this.state.qaAttempts });
  }

  /**
   * Run QA phase with retry loop (LEGACY — kept for reference)
   * Functional and visual tests run in parallel
   */
  private async runQA(phaseNumber: number): Promise<void> {
    this.log('\n=== PHASE: QA ===\n');
    auditPhase('qa', 'started', { buildPhase: phaseNumber });
    this.state.currentPhase = 'qa';

    // Clean stale QA artifacts before resetting counter (fixes resume picking up old .done files)
    const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
    if (existsSync(qaDir)) {
      const files = readdirSync(qaDir);
      for (const file of files) {
        if (file.endsWith('.done') || file.endsWith('.json') || file.endsWith('.md')) {
          unlinkSync(join(qaDir, file));
        }
      }
      this.log(`Cleaned ${files.length} stale QA artifacts from ${qaDir}`);
    }

    // Clean screenshots for this phase
    const screenshotsDir = `${SCREENSHOTS_DIR}/phase-${phaseNumber}`;
    if (existsSync(screenshotsDir)) {
      rmSync(screenshotsDir, { recursive: true, force: true });
      this.log(`Cleaned screenshots dir: ${screenshotsDir}`);
    }

    this.state.qaAttempts = 0;
    saveState(this.state);

    // Ensure QA directory exists
    if (!existsSync(qaDir)) {
      mkdirSync(qaDir, { recursive: true });
    }

    let qaPass = false;
    let preFixSha: string | null = null;  // Git SHA before fix agent runs
    let prevBlockerCount: number | null = null;  // Blocker count from previous verdict
    let rateLimitRetries = 0;

    while (!qaPass && this.state.qaAttempts < MAX_QA_ATTEMPTS) {
      this.state.qaAttempts++;
      const attempt = this.state.qaAttempts;
      saveState(this.state);

      this.log(`\n--- QA Attempt ${attempt}/${MAX_QA_ATTEMPTS} ---\n`);
      auditQA(phaseNumber, attempt, 'started');

      // ========== TIER 1: SMOKE TEST ==========
      this.log('--- Tier 1: Smoke Test ---');
      const smokeStart = Date.now();

      const smokeResult = await this.spawner.run({
        cwd: this.workDir,
        prompt: buildQaSmokePrompt(this.state, phaseNumber, attempt),
        timeoutMs: QA_TIMEOUT_MS,
        sessionName: `qa-smoke-${attempt}`,
        doneFile: `${QA_DIR}/phase-${phaseNumber}/smoke-${attempt}.done`,
        model: getModelForPhase('qa-smoke')
      });

      // Handle rate limiting — wait and retry without counting this attempt
      this.assertNotCreditExhausted(smokeResult);
      if (smokeResult.rateLimited) {
        rateLimitRetries = await this.waitForRateLimit(rateLimitRetries, 'QA smoke');
        this.state.qaAttempts--;
        saveState(this.state);
        continue;
      }

      // Brief delay after session ends to let in-flight file writes flush
      // (killed processes may have pending writes that complete after SIGTERM)
      const smokeResultPath = `${qaDir}/smoke-${attempt}.md`;
      if (!existsSync(smokeResultPath)) {
        await new Promise(r => setTimeout(r, 5000));
      }

      // Check smoke results - if major failures, skip other tests
      const smokeHasCriticalFailures = this.checkSmokeForCriticalFailures(smokeResultPath);

      if (smokeHasCriticalFailures) {
        this.log(`Smoke test has critical failures - skipping functional/visual tests`);

        // Create verdict from smoke alone
        this.createFallbackVerdict(qaDir, phaseNumber, attempt);

        const verdictGate = this.gates.checkQaVerdict(phaseNumber, attempt);
        auditGate(`qa-verdict-${attempt}`, verdictGate.passed);

        this.log(`QA FAILED (smoke) - ${verdictGate.message}`);
        this.state.lastQaVerdict = 'NEEDS_FIX';
        auditQA(phaseNumber, attempt, 'failed', { message: verdictGate.message, phase: 'smoke' });

        const currentBlockers = this.getBlockerCount(qaDir, attempt);
        let reverted = false;

        // Check if previous fix made things worse — revert if so
        if (preFixSha && prevBlockerCount !== null && currentBlockers > prevBlockerCount) {
          this.log(`⚠ FIX REGRESSION: ${prevBlockerCount} → ${currentBlockers} blockers. Reverting to pre-fix state...`);
          try {
            execSync(`git reset --hard ${preFixSha}`, { cwd: this.workDir, stdio: 'pipe' });
            this.log(`Reverted to ${preFixSha.slice(0, 8)}`);
            audit('fix_reverted', { details: { attempt, before: prevBlockerCount, after: currentBlockers, sha: preFixSha } });
            reverted = true;
          } catch (err) {
            this.log(`Failed to revert: ${err}`);
          }
        }

        // Run fixes
        if (this.state.qaAttempts < MAX_QA_ATTEMPTS) {
          preFixSha = this.getGitHead();
          prevBlockerCount = reverted ? prevBlockerCount : currentBlockers;
          await this.runChunkedFixes(phaseNumber, attempt);
          // No-op guard: a fix that changed nothing won't change the next verdict.
          if (this.fixWasNoop(preFixSha, attempt)) {
            saveState(this.state);
            break;
          }
        }

        saveState(this.state);
        continue;
      }

      this.log(`Smoke passed in ${Date.now() - smokeStart}ms - proceeding to functional + visual tests`);

      // ========== TIER 2+3: FUNCTIONAL + VISUAL (PARALLEL) ==========
      this.log('--- Tier 2+3: Functional + Visual (PARALLEL) ---');
            // Build QA tasks — skip visual for non-visual project types
      const qaTasks = [
        {
          cwd: this.workDir,
          prompt: buildQaFunctionalPrompt(this.state, phaseNumber, attempt),
          timeoutMs: QA_TIMEOUT_MS,
          sessionName: `qa-functional-${attempt}`,
          doneFile: `${QA_DIR}/phase-${phaseNumber}/functional-${attempt}.done`,
          model: getModelForPhase('qa-functional')
        }
      ];

      const skipVisual = shouldSkipVisualQA(this.state.projectType || 'web-fullstack');
      if (skipVisual) {
        this.log(`Skipping visual QA — project type "${this.state.projectType}" has no visual component`);
      } else {
        qaTasks.push({
          cwd: this.workDir,
          prompt: buildQaVisualPrompt(this.state, phaseNumber, attempt),
          timeoutMs: QA_TIMEOUT_MS,
          sessionName: `qa-visual-${attempt}`,
          doneFile: `${QA_DIR}/phase-${phaseNumber}/visual-${attempt}.done`,
          model: getModelForPhase('qa-visual')
        });
      }

      const qaResults = await this.spawner.runParallel(qaTasks, skipVisual ? 1 : 2);

      // Handle rate limiting in QA sessions
      this.assertNotCreditExhausted(qaResults);
      if (qaResults.some(r => r.rateLimited)) {
        rateLimitRetries = await this.waitForRateLimit(rateLimitRetries, 'parallel QA');
        this.state.qaAttempts--;
        saveState(this.state);
        continue;
      }

      // ========== VERDICT ==========
      this.log('--- Generating Verdict ---');
      await this.spawner.run({
        cwd: this.workDir,
        prompt: buildQaVerdictPrompt(this.state, phaseNumber, attempt),
        timeoutMs: QA_TIMEOUT_MS / 2,
        sessionName: `qa-verdict-${attempt}`,
        doneFile: `${QA_DIR}/phase-${phaseNumber}/verdict-${attempt}.done`,
        model: getModelForPhase('qa-verdict')
      });

      // Fallback: if verdict file wasn't created, create one from smoke report
      const verdictPath = `${qaDir}/verdict-${attempt}.json`;
      if (!existsSync(verdictPath)) {
        this.log('Verdict file not created by agent, creating fallback from smoke report...');
        this.createFallbackVerdict(qaDir, phaseNumber, attempt);
      }

      // Check verdict gate
      const verdictGate = this.gates.checkQaVerdict(phaseNumber, attempt);
      auditGate(`qa-verdict-${attempt}`, verdictGate.passed);
      if (verdictGate.passed) {
        this.log('QA PASSED - verdict is CLEAN');
        qaPass = true;
        this.state.lastQaVerdict = 'CLEAN';
        auditQA(phaseNumber, attempt, 'passed');
      } else {
        this.log(`QA FAILED - ${verdictGate.message}`);
        this.state.lastQaVerdict = 'NEEDS_FIX';
        auditQA(phaseNumber, attempt, 'failed', { message: verdictGate.message });

        const currentBlockers = this.getBlockerCount(qaDir, attempt);
        let reverted = false;

        // Check if previous fix made things worse — revert if so
        if (preFixSha && prevBlockerCount !== null && currentBlockers > prevBlockerCount) {
          this.log(`⚠ FIX REGRESSION: ${prevBlockerCount} → ${currentBlockers} blockers. Reverting to pre-fix state...`);
          try {
            execSync(`git reset --hard ${preFixSha}`, { cwd: this.workDir, stdio: 'pipe' });
            this.log(`Reverted to ${preFixSha.slice(0, 8)}`);
            audit('fix_reverted', { details: { attempt: attempt - 1, before: prevBlockerCount, after: currentBlockers, sha: preFixSha } });
            reverted = true;
          } catch (err) {
            this.log(`Failed to revert: ${err}`);
          }
        }

        // Determine effective max attempts — cap at 3 if only warnings remain
        const warningsOnly = this.isWarningsOnly(qaDir, attempt);
        const effectiveMax = warningsOnly ? MAX_QA_ATTEMPTS_WARNINGS_ONLY : MAX_QA_ATTEMPTS;
        if (warningsOnly && this.state.qaAttempts >= MAX_QA_ATTEMPTS_WARNINGS_ONLY) {
          this.log(`Only warnings remain after ${this.state.qaAttempts} attempts — accepting and moving on`);
          qaPass = true;
          this.state.lastQaVerdict = 'CLEAN';
          auditQA(phaseNumber, attempt, 'passed', { note: 'warnings-only acceptance' });
          break;
        }

        // Run fix agents if not last attempt
        if (this.state.qaAttempts < effectiveMax) {
          // Snapshot git state before fix — revert next round if fix makes things worse
          preFixSha = this.getGitHead();
          // After revert, keep original blocker count as baseline (not the inflated regression count)
          prevBlockerCount = reverted ? prevBlockerCount : currentBlockers;
          await this.runChunkedFixes(phaseNumber, attempt);
          // No-op guard: if the fix edited nothing, the next QA round repeats this verdict.
          if (this.fixWasNoop(preFixSha, attempt)) {
            saveState(this.state);
            break;
          }
        }
      }

      saveState(this.state);
    }

    if (!qaPass) {
      this.log('QA FAILED after maximum attempts');
      auditPhase('qa', 'completed', { passed: false, attempts: this.state.qaAttempts });
      process.exit(1);
    }

    auditPhase('qa', 'completed', { passed: true, attempts: this.state.qaAttempts });
  }

  /**
   * Check smoke test results for critical failures
   */
  private checkSmokeForCriticalFailures(smokePath: string): boolean {
    if (!existsSync(smokePath)) {
      return true;
    }

    try {
      const content = readFileSync(smokePath, 'utf-8');

      const criticalPatterns = [
        /database.*(not running|connection.*fail|cannot connect)/i,
        /server.*(not start|fail.*start|crash)/i,
        /backend.*(not running|fail)/i,
        /port.*not.*listening/i,
        /ECONNREFUSED/i,
        /compilation.*failed/i,
        /npm run build.*fail/i,
        /fatal error:/i,
        /## CRITICAL/i,
        /status:\s*BLOCKED/i
      ];

      for (const pattern of criticalPatterns) {
        if (pattern.test(content)) {
          return true;
        }
      }

      if (content.match(/^#+\s*SMOKE.*FAIL/im)) {
        return true;
      }

      return false;
    } catch {
      return true;
    }
  }

  /**
   * Run code review phase
   */
  private async runCodeReview(phaseNumber: number): Promise<void> {
    this.log('\n=== PHASE: CODE REVIEW ===\n');
    this.state.currentPhase = 'review';
    saveState(this.state);

    await this.spawner.run({
      cwd: this.workDir,
      prompt: buildCodeReviewPrompt(this.state, phaseNumber),
      timeoutMs: QA_TIMEOUT_MS,
      sessionName: `code-review-${phaseNumber}`,
      doneFile: `${REVIEWS_DIR}/phase-${phaseNumber}.done`,
      model: getModelForPhase('code-review')
    });

    enforceGate(this.gates.checkCodeReview(phaseNumber));
  }

  /**
   * Merge a phase branch into its target, recovering from conflicts with a
   * merge-fix agent instead of hard-failing. A conflict means the target moved
   * (e.g. a concurrent hotfix on main) in a way that overlaps the phase work;
   * rather than discard a side (data loss) or stop the whole run, an agent
   * resolves the conflict keeping both intents. Returns false only when the
   * conflict is genuinely unresolvable (agent aborts or attempts exhaust) — the
   * caller then stops with the work preserved on the phase branch.
   */
  private async mergeWithResolution(phaseNumber: number, sourceBranch: string, targetBranch: string): Promise<boolean> {
    const outcome = this.github.tryMerge(sourceBranch, targetBranch);
    if (outcome.status === 'clean') {
      this.log(`Merged ${sourceBranch} into ${targetBranch}`);
      return true;
    }
    if (outcome.status === 'error') {
      this.log(`Merge error (${outcome.detail ?? 'unknown'}) — cannot auto-resolve.`);
      this.github.abortMerge();
      return false;
    }

    // status === 'conflict' — the merge is left in progress; resolve with an agent.
    const MAX_MERGE_FIX_ATTEMPTS = 3;
    let conflicted = outcome.conflictedPaths ?? this.github.getConflictedPaths();
    this.log(`Merge conflict in ${conflicted.length} file(s): ${conflicted.join(', ')}. Running merge-fix...`);

    for (let attempt = 1; attempt <= MAX_MERGE_FIX_ATTEMPTS; attempt++) {
      const resolved = await this.runMergeFix(phaseNumber, sourceBranch, targetBranch, conflicted, attempt);
      if (!resolved) {
        this.log(`Merge-fix attempt ${attempt} did not resolve the conflict — aborting merge.`);
        this.github.abortMerge();
        return false;
      }
      // Agent reported success: it either committed the merge or just staged the
      // resolutions. Complete the merge commit if needed, then verify it's clean.
      const remaining = this.github.getConflictedPaths();
      if (remaining.length === 0) {
        if (this.github.completeMerge(`Merge ${sourceBranch} into ${targetBranch} (phase ${phaseNumber})`)) {
          this.log(`Merge-fix resolved the conflict; merged ${sourceBranch} into ${targetBranch}`);
          audit('phase_merge_fixed', { buildPhase: phaseNumber, details: { source: sourceBranch, target: targetBranch, attempt } });
          return true;
        }
        this.log('Merge-fix staged a resolution but the merge commit failed — aborting.');
        this.github.abortMerge();
        return false;
      }
      conflicted = remaining; // still conflicted — try again on what's left
    }

    this.log(`Merge-fix exhausted ${MAX_MERGE_FIX_ATTEMPTS} attempts; conflict unresolved — aborting merge.`);
    this.github.abortMerge();
    return false;
  }

  /**
   * Spawn a merge-fix agent to resolve an in-progress merge conflict. Returns
   * true only on an explicit OK done-signal; an ABORTED signal, a missing done
   * file, or a non-zero exit all return false.
   */
  private async runMergeFix(
    phaseNumber: number,
    sourceBranch: string,
    targetBranch: string,
    conflictedPaths: string[],
    attempt: number
  ): Promise<boolean> {
    const phase = this.state.buildPhases.find(p => p.number === phaseNumber);
    const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
    mkdirSync(qaDir, { recursive: true });
    const doneFile = `${qaDir}/merge-fix-${attempt}.done`;
    if (existsSync(doneFile)) { try { unlinkSync(doneFile); } catch { /* ignore */ } }

    const result = await this.spawner.run({
      cwd: this.workDir,
      prompt: buildMergeFixPrompt({
        repoPath: this.workDir,
        branchName: sourceBranch,
        baseBranch: targetBranch,
        conflictedPaths,
        mode: 'merge',
        contextKey: `phase-${phaseNumber}`,
        contextSummary: phase?.name,
        doneFile,
      }),
      timeoutMs: FIX_TIMEOUT_MS,
      sessionName: `merge-fix-phase-${phaseNumber}-${attempt}`,
      doneFile,
      model: getModelForPhase('qa-fix')
    });

    this.assertNotCreditExhausted(result);
    if (result.exitCode !== 0 || !existsSync(doneFile)) return false;

    const doneContent = readFileSync(doneFile, 'utf-8').trim();
    if (doneContent.startsWith('ABORTED')) {
      this.log(`Merge-fix reported it could not resolve the conflict: ${doneContent}`);
      return false;
    }
    return true;
  }

  /**
   * Run AAR phase
   */
  private async runAAR(phaseNumber: number): Promise<void> {
    this.log('\n=== PHASE: AAR ===\n');
    this.state.currentPhase = 'aar';
    saveState(this.state);

    await this.spawner.run({
      cwd: this.workDir,
      prompt: buildAarPrompt(this.state, phaseNumber),
      timeoutMs: AAR_TIMEOUT_MS,
      sessionName: `aar-${phaseNumber}`,
      doneFile: `${AAR_DIR}/phase-${phaseNumber}.done`,
      model: getModelForPhase('aar')
    });

    // The AAR agent must NOT touch state.json — the prompt explicitly forbids
    // it. Belt-and-suspenders: re-save the in-memory state to overwrite any
    // stray edits. We do NOT loadState() here because a corrupted state.json
    // would fall back to defaults (empty buildPhases) and silently kill the
    // phase loop with "ORCHESTRATION COMPLETE" after one phase.
    saveState(this.state);

    enforceGate(this.gates.checkAAR(phaseNumber));
  }

  /**
   * Fail fast if any session was rejected for programmatic-credit exhaustion.
   * Unlike a transient 429, this won't recover by waiting — retrying just burns
   * the session timeout until the billing cycle resets. Throwing surfaces a clear,
   * actionable message (the run aborts via index.ts's top-level catch).
   */
  private assertNotCreditExhausted(results: SpawnResult | SpawnResult[]): void {
    const arr = Array.isArray(results) ? results : [results];
    if (arr.some(r => r.creditExhausted)) {
      throw new Error(
        'Programmatic credit exhausted. The Claude Code session was rejected with a ' +
        'credit/usage-limit error that resets at the next billing cycle — not a transient ' +
        'rate limit, so retrying will not help. To continue now, enable "extra usage" in the ' +
        'Claude Console (Settings → Billing) so overflow bills at pay-as-you-go API rates ' +
        '(set a spend cap), or wait for the monthly credit to reset. Then run `turkeycode resume`.'
      );
    }
  }

  /**
   * Handle a rate-limited session: fail fast on credit exhaustion, otherwise wait and
   * allow a bounded number of transient retries. Returns the next retry count; throws
   * once MAX_RATE_LIMIT_RETRIES is exceeded so the loop can't spin forever.
   */
  private async waitForRateLimit(retries: number, context: string): Promise<number> {
    if (retries >= MAX_RATE_LIMIT_RETRIES) {
      throw new Error(
        `Persistent rate limiting during ${context} after ${MAX_RATE_LIMIT_RETRIES} retries — aborting. ` +
        `If this recurs, your account may be at its per-minute limit or out of programmatic credit; ` +
        `check the Claude Console. Resume with \`turkeycode resume\`.`
      );
    }
    this.log(`Rate limit detected during ${context} — waiting 5 minutes before retry (${retries + 1}/${MAX_RATE_LIMIT_RETRIES})...`);
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    return retries + 1;
  }

  /**
   * Polish pass — end-of-build, repo-wide warning cleanup.
   *
   * In the defer-warnings model, per-phase QA gates on blockers only, so warnings
   * pile up across phases. This single pass discovers and fixes them all coherently,
   * then RE-VERIFIES the build with the deterministic quick-check (zero LLM tokens)
   * before merging. The re-verify is what makes "perfect" honest: we never merge a
   * cleanup that broke compilation or boot.
   *
   * Best-effort by design: the build already passed functional QA per phase, so
   * stubborn warnings never fail the whole run — they're logged and the (verified-safe)
   * cleanup is merged anyway. Only a regression (broken build) aborts the merge.
   */
  private async runPolishPhase(): Promise<void> {
    this.log('\n' + '='.repeat(60));
    this.log('POLISH PASS — repo-wide warning cleanup');
    this.log('='.repeat(60));

    this.state.currentPhase = 'polish';
    saveState(this.state);
    auditPhase('polish', 'started');

    // Clean stale polish artifacts so we read this run's verdicts, not last run's.
    if (existsSync(POLISH_DIR)) {
      for (const f of readdirSync(POLISH_DIR)) {
        if (f.endsWith('.json') || f.endsWith('.done')) unlinkSync(join(POLISH_DIR, f));
      }
    } else {
      mkdirSync(POLISH_DIR, { recursive: true });
    }

    const defaultBranch = this.github.getDefaultBranch();
    const polishBranch = 'polish/warnings';
    this.github.createBranch(polishBranch, defaultBranch);

    // Snapshot the pre-polish commit so we can revert if a fix breaks the build.
    const preSha = this.getGitHead();

    let clean = false;
    let merged = false;

    for (let attempt = 1; attempt <= MAX_POLISH_ATTEMPTS; attempt++) {
      this.log(`\n--- Polish attempt ${attempt}/${MAX_POLISH_ATTEMPTS} ---\n`);

      await this.spawner.run({
        cwd: this.workDir,
        prompt: buildPolishPrompt(this.state, attempt),
        timeoutMs: POLISH_TIMEOUT_MS,
        sessionName: `polish-${attempt}`,
        doneFile: `${POLISH_DIR}/polish-${attempt}.done`,
        model: getModelForPhase('polish')
      });

      // Commit whatever the polish session changed.
      if (this.github.hasUncommittedChanges()) {
        this.github.commit(`polish: warning cleanup (attempt ${attempt})`);
      }

      // Nothing changed AND verdict says clean → no warnings existed. Done.
      const verdict = this.readPolishVerdict(attempt);
      const noChanges = this.getGitHead() === preSha;
      if (noChanges && (!verdict || verdict.remainingWarnings === 0)) {
        this.log('Polish: no warnings to fix — codebase already clean.');
        clean = true;
        break;
      }

      // Deterministic regression check — did the cleanup break compilation/boot?
      this.log('Verifying build still passes after cleanup...');
      const check = await runQuickChecks(this.workDir);
      for (const c of check.checks) {
        this.log(`  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.message}`);
      }

      if (!check.passed) {
        // The cleanup broke the build. Revert to pre-polish state.
        this.log('⚠ Polish introduced a regression — reverting cleanup.');
        if (preSha) {
          try { execSync(`git reset --hard ${preSha}`, { cwd: this.workDir, stdio: 'pipe' }); } catch { /* best effort */ }
        }
        if (attempt < MAX_POLISH_ATTEMPTS) {
          this.log('Retrying polish from a clean slate...');
          continue;
        }
        this.log('Polish exhausted attempts without a safe result — keeping build as-is, warnings remain.');
        auditPhase('polish', 'completed', { clean: false, reason: 'regression', attempts: attempt });
        break;
      }

      // Build is safe. Accept if warnings hit zero, or if this was the last attempt.
      if (verdict && verdict.remainingWarnings === 0) {
        this.log(`Polish CLEAN — ${verdict.fixed ?? 0} warning(s) fixed, zero remaining.`);
        clean = true;
      } else {
        const remaining = verdict?.remainingWarnings ?? 'unknown';
        if (attempt < MAX_POLISH_ATTEMPTS && verdict) {
          this.log(`${remaining} warning(s) remain — running another polish attempt...`);
          continue;
        }
        this.log(`Polish best-effort: ${remaining} warning(s) remain but build is verified safe — merging cleanup.`);
      }

      // Merge the verified cleanup into the default branch.
      merged = this.mergePolishBranch(polishBranch, defaultBranch);
      break;
    }

    if (clean && !merged) {
      // "no warnings existed" path: nothing was committed, so just drop the branch.
      this.log('Polish complete — nothing to merge.');
    }

    auditPhase('polish', 'completed', { clean, merged });
    this.log('=== POLISH PASS COMPLETE ===\n');
  }

  /** Read and parse a polish verdict JSON, or null if missing/unparseable. */
  private readPolishVerdict(attempt: number): { verdict?: string; remainingWarnings?: number; fixed?: number } | null {
    const path = `${POLISH_DIR}/verdict-${attempt}.json`;
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Merge the polish branch into the default branch (PR when a remote exists, else local). */
  private mergePolishBranch(polishBranch: string, defaultBranch: string): boolean {
    if (!this.github.branchExists(polishBranch)) {
      // Built directly on default — already merged.
      return true;
    }
    if (this.github.hasRemote()) {
      this.github.push(polishBranch);
      const existing = this.github.findExistingPR(polishBranch);
      const pr = existing || this.github.createPR({
        title: 'Polish: warning cleanup',
        body: 'Repo-wide warning cleanup (defer-warnings polish pass). Build re-verified after cleanup.',
        base: defaultBranch,
        head: polishBranch
      });
      let merged = pr ? this.github.mergePR(pr) : false;
      if (!merged) {
        merged = this.github.mergeBranch(polishBranch, defaultBranch);
        if (merged) this.github.push(defaultBranch);
      }
      return merged;
    }
    return this.github.mergeBranch(polishBranch, defaultBranch);
  }

  /**
   * Create a fallback verdict when the verdict agent fails
   */
  private createFallbackVerdict(qaDir: string, phaseNumber: number, attempt: number): void {
    const smokePath = `${qaDir}/smoke-${attempt}.md`;
    const verdictPath = `${qaDir}/verdict-${attempt}.json`;

    const blockers: Array<{ type: string; description: string; location: string; severity: string }> = [];

    if (existsSync(smokePath)) {
      const smokeContent = readFileSync(smokePath, 'utf-8');

      if (smokeContent.includes('FAIL') || smokeContent.includes('DEAD') || smokeContent.includes('BLOCKER')) {
        const deadMatch = smokeContent.match(/### ?\d+\. .+?- BLOCKER[\s\S]*?(?=###|$)/g);
        if (deadMatch) {
          for (const match of deadMatch) {
            const descMatch = match.match(/### ?\d+\. (.+?) - BLOCKER/);
            const locationMatch = match.match(/\*\*Location:\*\* (.+)/);
            if (descMatch) {
              blockers.push({
                type: 'smoke',
                description: descMatch[1].trim(),
                location: locationMatch ? locationMatch[1].trim() : 'unknown',
                severity: 'critical'
              });
            }
          }
        }

        if (blockers.length === 0) {
          blockers.push({
            type: 'smoke',
            description: 'Smoke test found failures - see smoke report for details',
            location: smokePath,
            severity: 'critical'
          });
        }
      }
    } else {
      blockers.push({
        type: 'smoke',
        description: 'Smoke test report not created',
        location: smokePath,
        severity: 'critical'
      });
    }

    const verdict = blockers.length === 0 ? 'CLEAN' : 'NEEDS_FIX';

    const verdictJson = {
      verdict,
      timestamp: new Date().toISOString(),
      phase: phaseNumber,
      attempt,
      summary: {
        smoke: { passed: blockers.length === 0, errors: blockers.length },
        functional: { passed: true, note: 'Not tested - fallback verdict' },
        visual: { passed: true, note: 'Not tested - fallback verdict' }
      },
      blockers,
      warnings: [],
      notes: `Fallback verdict created by orchestrator. ${blockers.length} blockers found in smoke report.`
    };

    writeFileSync(verdictPath, JSON.stringify(verdictJson, null, 2));
    this.log(`Created fallback verdict: ${verdict} (${blockers.length} blockers)`);
  }

  /**
   * Fold the dedicated visual QA pass's findings (visual-N.json) into the phase
   * verdict (verdict-N.json). Visual blockers must gate the phase exactly like
   * functional blockers — the verdict is the single source of truth the gate,
   * blocker-count, warnings-only, and fix-prompt logic all read. Best-effort: a
   * missing/garbled visual report never crashes QA (the combined verdict still
   * carries its own design rubric as a safety net).
   */
  private mergeVisualFindings(qaDir: string, phaseNumber: number, attempt: number): void {
    const visualJsonPath = `${qaDir}/visual-${attempt}.json`;
    const verdictPath = `${qaDir}/verdict-${attempt}.json`;

    if (!existsSync(visualJsonPath)) {
      this.log('Visual QA produced no machine-readable report (visual-N.json) — skipping merge');
      return;
    }
    if (!existsSync(verdictPath)) {
      this.log('No verdict file to merge visual findings into — skipping merge');
      return;
    }

    try {
      const visual = JSON.parse(readFileSync(visualJsonPath, 'utf-8'));
      const visualBlockers = Array.isArray(visual.blockers) ? visual.blockers : [];
      const visualWarnings = Array.isArray(visual.warnings) ? visual.warnings : [];

      if (visualBlockers.length === 0 && visualWarnings.length === 0) {
        this.log('Visual QA: 0 blockers, 0 warnings — verdict unchanged');
        return;
      }

      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      const merged = mergeVisualIntoVerdict(verdict, visual);
      writeFileSync(verdictPath, JSON.stringify(merged, null, 2));
      this.log(`Merged visual QA into verdict: +${visualBlockers.length} blockers, +${visualWarnings.length} warnings`);
    } catch (err) {
      this.log(`Failed to merge visual findings (non-fatal): ${err}`);
    }
  }

  /**
   * Ensure a .gitignore exists in the work directory based on detected project type.
   * Prevents node_modules, build artifacts, etc. from being committed.
   */
  private ensureGitignore(): void {
    const gitignorePath = join(this.workDir, '.gitignore');

    // Patterns that MUST be ignored or a phase merge breaks: build artifacts and
    // turkeycode state mutate during build/QA, and a committed copy makes the
    // phase-merge git checkout abort ("untracked working tree files would be
    // overwritten by merge"). An agent's .gitignore that omits .next/ is exactly
    // how that happens.
    const CRITICAL_IGNORES = [
      'node_modules/', '.turkey/', '.next/', '.nuxt/', '.output/', '.vercel/',
      'dist/', 'build/', 'out/', 'coverage/',
    ];

    if (existsSync(gitignorePath)) {
      // A .gitignore already exists (build agents create one). Guarantee every
      // critical artifact pattern is present, not just .turkey/.
      const content = readFileSync(gitignorePath, 'utf-8');
      const missing = CRITICAL_IGNORES.filter((p) => {
        const base = p.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return !new RegExp('^\\s*' + base + '/?\\s*$', 'm').test(content);
      });
      if (missing.length > 0) {
        writeFileSync(gitignorePath, content.replace(/\s*$/, '') + '\n\n# turkeycode: never commit (build artifacts + state)\n' + missing.join('\n') + '\n');
        this.log(`Ensured critical .gitignore entries: ${missing.join(', ')}`);
      }
      this.untrackIgnoredArtifacts();
      return;
    }

    const tech = this.state.tech;
    const stack = (tech.frontend || '') + ' ' + (tech.backend || '') + ' ' + ((tech as Record<string, unknown>).framework || '');
    const lines: string[] = [
      '# Dependencies',
      'node_modules/',
      '.pnp.*',
      '.yarn/',
      '',
      '# Build output',
      'dist/',
      'build/',
      'out/',
      '.next/',
      '.nuxt/',
      '.output/',
      '.vercel/',
      '',
      '# Environment',
      '.env',
      '.env.local',
      '.env*.local',
      '',
      '# OS',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# IDE',
      '.idea/',
      '.vscode/',
      '*.swp',
      '*.swo',
      '',
      '# Logs',
      '*.log',
      'npm-debug.log*',
    ];

    // Python
    if (/python|django|flask|fastapi/i.test(stack) || tech.packageManager === 'pip') {
      lines.push('', '# Python', '__pycache__/', '*.pyc', '.venv/', 'venv/', '*.egg-info/');
    }

    // Rust
    if (/rust|cargo/i.test(stack)) {
      lines.push('', '# Rust', 'target/');
    }

    // Go
    if (/\bgo\b|gin|fiber/i.test(stack)) {
      lines.push('', '# Go', '/bin/');
    }

    // Java/Kotlin
    if (/java|spring|kotlin|gradle|maven/i.test(stack)) {
      lines.push('', '# Java', '*.class', '.gradle/', 'build/', 'target/');
    }

    // Testing
    lines.push('', '# Test artifacts', 'coverage/', 'playwright-report/', 'test-results/');

    // turkeycode runtime state — must never be committed (mutates every phase; a tracked
    // copy makes `git checkout`/merge fail on branch switches).
    lines.push('', '# turkeycode runtime state — never commit', '.turkey/');

    lines.push('');

    writeFileSync(gitignorePath, lines.join('\n'));
    this.log('Created .gitignore based on project type');
    this.untrackIgnoredArtifacts();
  }

  /**
   * Untrack .turkey/ if a prior run (or a build agent's `git add -A`) committed it.
   * turkeycode's state mutates every phase; if it's tracked, `git checkout <target>`
   * during a phase merge aborts with "local changes would be overwritten", which used
   * to kill the run on the local-merge path (no remote / --no-push). Files stay on disk.
   */
  private untrackIgnoredArtifacts(): void {
    // Drop turkeycode state AND build artifacts from the index if any ever got
    // tracked (e.g. an agent committed .next/ before .gitignore covered it). A
    // tracked, mutating artifact makes the phase-merge git checkout abort.
    const paths = ['.turkey', '.next', '.nuxt', '.output', '.vercel', 'dist', 'build', 'out', 'coverage'];
    try {
      const tracked = execSync(`git ls-files ${paths.join(' ')}`, { cwd: this.workDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (tracked) {
        execSync(`git rm -r --cached --quiet --ignore-unmatch ${paths.join(' ')}`, { cwd: this.workDir, stdio: 'pipe' });
        this.log('Untracked build artifacts + turkeycode state from git (must never be committed)');
      }
    } catch { /* not a git repo yet, or nothing tracked — fine */ }
  }

  /**
   * Get current git HEAD SHA
   */
  private getGitHead(): string | null {
    try {
      return execSync('git rev-parse HEAD', { cwd: this.workDir, stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  }

  /**
   * Detect a no-op fix: a fix session that committed nothing (HEAD unchanged since
   * the pre-fix snapshot), i.e. the agent reported fixes but edited no files. The
   * QA gates only verify a `.done` signal, not real work, so a no-op fix otherwise
   * sails through and the loop re-runs full (expensive) QA on identical code —
   * producing the same verdict and burning every remaining attempt. When the fix
   * changed nothing, stop: re-running QA can't help, and a fresh build attempt is
   * far more useful than another identical no-op fix.
   */
  private fixWasNoop(preFixSha: string | null, attempt: number): boolean {
    if (!preFixSha) return false;
    const head = this.getGitHead();
    if (isNoopFix(head, preFixSha)) {
      this.log(
        `✖ Fix attempt ${attempt} changed NOTHING (empty diff vs ${preFixSha.slice(0, 8)}) — ` +
        `the agent reported fixes but edited no files. Stopping QA retries; re-running QA on ` +
        `unchanged code only repeats the same verdict.`
      );
      audit('fix_noop', { details: { attempt, sha: preFixSha } });
      return true;
    }
    return false;
  }

  /**
   * Check if a verdict has only warnings (no blockers)
   */
  private isWarningsOnly(qaDir: string, attempt: number): boolean {
    const verdictPath = `${qaDir}/verdict-${attempt}.json`;
    if (!existsSync(verdictPath)) return false;
    try {
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      const blockers = (verdict.blockers || []).length;
      const warnings = (verdict.warnings || []).length;
      return blockers === 0 && warnings > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get blocker count from a verdict file
   */
  private getBlockerCount(qaDir: string, attempt: number): number {
    const verdictPath = `${qaDir}/verdict-${attempt}.json`;
    if (!existsSync(verdictPath)) return 0;
    try {
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      return (verdict.blockers || []).length;
    } catch {
      return 0;
    }
  }

  /**
   * Run fixes - single session with full context
   */
  private async runChunkedFixes(phaseNumber: number, attempt: number): Promise<void> {
    const qaDir = `${QA_DIR}/phase-${phaseNumber}`;
    const verdictPath = `${qaDir}/verdict-${attempt}.json`;

    // Load blockers from verdict (fall back to warnings if blockers is empty,
    // since CLEAN requires ZERO issues including warnings)
    let blockers: Array<{ type: string; description: string; location: string; severity?: string }> = [];
    if (existsSync(verdictPath)) {
      try {
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
        blockers = verdict.blockers || [];
        if (blockers.length === 0 && verdict.warnings?.length > 0) {
          this.log('No blockers found but warnings exist - treating warnings as blockers');
          blockers = verdict.warnings;
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (blockers.length === 0) {
      this.log('No blockers to fix');
      return;
    }

    this.log(`Fixing ${blockers.length} issues in single session...`);
    await this.spawner.run({
      cwd: this.workDir,
      prompt: buildQaFixPrompt(this.state, phaseNumber, attempt),
      timeoutMs: FIX_TIMEOUT_MS,
      sessionName: `qa-fix-${attempt}`,
      doneFile: `${QA_DIR}/phase-${phaseNumber}/fix-${attempt}.done`,
      model: getModelForPhase('qa-fix')
    });

    // Commit all fixes together
    const phase = this.state.buildPhases.find(p => p.number === phaseNumber);
    this.github.commit(`fix: QA attempt ${attempt} - fixed ${blockers.length} blockers`);
    if (phase?.branchName) {
      this.github.push(phase.branchName);
    }
  }

  /**
   * Generate PR body for a build phase
   */
  private generatePRBody(phase: BuildPhase): string {
    const deliverables = phase.deliverables
      .map(d => `- ${d}`)
      .join('\n');

    const criteria = phase.acceptanceCriteria
      .map(ac => `- ${ac}`)
      .join('\n');

    return `## Phase ${phase.number}: ${phase.name}

### Scope
${phase.scope}

### Deliverables
${deliverables}

### Acceptance Criteria
${criteria}

---
Generated by turkeycode (phase-based)
`;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);

    if (minutes > 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}h ${mins}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Preflight check: verify Claude Code is installed and working
   * Catches common issues before wasting time on a full build
   */
  private assertSafeWorkDir(): void {
    if (!isUnsafeWorkDir(this.workDir, homedir())) return;
    this.log('');
    this.log(`✖ Refusing to build in ${this.workDir}`);
    this.log(`  turkeycode initializes a git repo and writes files in the CURRENT directory.`);
    this.log(`  This is your home or a system directory — building here would scatter a`);
    this.log(`  project across it. Create an empty folder and run from inside it:`);
    this.log('');
    this.log(`      mkdir my-app && cd my-app`);
    this.log(`      turkeycode run "<your description>"`);
    this.log('');
    process.exit(1);
  }

  private async preflightCheck(): Promise<void> {
    this.log('Running preflight checks...');

    // 1. Check claude CLI exists
    try {
      const { execSync } = require('child_process');
      const version = execSync('claude --version 2>&1', { encoding: 'utf-8', timeout: 10000 }).trim();
      this.log(`Claude CLI: ${version}`);
    } catch {
      console.error('\n❌ Claude Code CLI not found.');
      console.error('Install it: npm install -g @anthropic-ai/claude-code');
      console.error('Then run: claude (to complete initial setup)\n');
      process.exit(1);
    }

    // 2. Quick smoke test — verify --print and --dangerously-skip-permissions work.
    // Prompt must elicit a TEXT reply, not an action: phrasing like "write X to
    // stdout" makes claude run a tool (echo) instead of replying, leaving --print
    // output empty. Retry guards against a transient blank response.
    const PREFLIGHT_PROMPT = 'Reply with only the word TURKEY as plain text. Do not use any tools.';
    let testResult = await this.spawner.run({
      cwd: this.workDir,
      prompt: PREFLIGHT_PROMPT,
      timeoutMs: 30000,
      sessionName: 'preflight',
    });
    for (let attempt = 2; attempt <= 3 && (testResult.exitCode !== 0 || testResult.stdout.trim().length < 3); attempt++) {
      this.log(`Preflight smoke test inconclusive (exit ${testResult.exitCode}, ${testResult.stdout.trim().length} chars) — retry ${attempt}/3...`);
      testResult = await this.spawner.run({
        cwd: this.workDir,
        prompt: PREFLIGHT_PROMPT,
        timeoutMs: 30000,
        sessionName: 'preflight',
      });
    }

    if (testResult.exitCode !== 0 || testResult.stdout.trim().length < 3) {
      console.error('\n❌ Claude Code preflight failed.');
      console.error(`Exit code: ${testResult.exitCode}`);
      if (testResult.stdout.length > 0) {
        console.error(`Output: ${testResult.stdout.substring(0, 500)}`);
      }
      if (testResult.stderr.length > 0) {
        console.error(`Stderr: ${testResult.stderr.substring(0, 500)}`);
      }
      console.error('\nPossible fixes:');
      console.error('1. Run "claude" once to complete initial setup');
      console.error('2. Make sure you have an active Claude subscription or API key');
      console.error('3. Try: claude --print "hello" to verify it works\n');
      process.exit(1);
    }

    this.log('Preflight passed ✓');
  }

  /**
   * Log a message with timestamp
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }
}

/**
 * Create an orchestrator instance
 */
export function createOrchestrator(options?: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}
