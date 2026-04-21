/**
 * Main orchestrator for turkey-enterprise-v3
 * Phase-based model: 2-5 build phases, each one Claude session
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  ProjectState,
  BuildPhase
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
  buildAarPrompt
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
  QA_DIR,
  SCREENSHOTS_DIR,
  RESEARCH_DONE,
  PLAN_DONE,
  PHASES_DIR,
  PHASE_PLAN_FILE,
  REFERENCE_DIR,
  SPECS_FILE,
  REVIEWS_DIR,
  AAR_DIR,
  getModelForPhase
} from './constants';
import { audit, auditGate, auditPhase, auditBuildPhase, auditQA } from './audit';
import { runQuickChecks } from './quick-check';
import { detectProjectType } from './detect-project-type';
import { shouldSkipVisualQA } from './types';

export interface OrchestratorOptions {
  verbose?: boolean;
  jiraProject?: string;
  githubRepo?: string;
  specFile?: string;
  noPush?: boolean;
  noPr?: boolean;
}

/**
 * Main orchestrator class
 * Phase-based: 2-5 build phases, each one Claude session
 */
export class Orchestrator {
  private state: ProjectState;
  private spawner: Spawner;
  private gates: Gates;
  private jira: JiraClient;
  private github: GitHubClient;
  private verbose: boolean;
  private workDir: string;

  constructor(options: OrchestratorOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.workDir = process.cwd();
    this.state = loadState();
    this.spawner = createSpawner({ verbose: this.verbose });
    this.gates = createGates();
    this.jira = createJiraClient(options.jiraProject || this.state.jiraProject);
    this.github = createGitHubClient();
    this.github.workDir = this.workDir;
    if (options.noPush) this.github.noPush = true;
    if (options.noPr) this.github.noPr = true;
  }

  /**
   * Run the full orchestration loop
   */
  async run(description: string, options: OrchestratorOptions = {}): Promise<void> {
    this.log('='.repeat(60));
    this.log('TURKEY ENTERPRISE V3 - PHASE-BASED ORCHESTRATION');
    this.log('='.repeat(60));

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
      if (this.jira.isEnabled()) {
        const projectKey = await this.jira.ensureProject(description);
        if (projectKey) {
          this.state.jiraProject = projectKey;
          saveState(this.state);
          this.log(`Jira project ready: ${projectKey}`);
        }
      }
    }

    // ==================== DETECT PROJECT TYPE ====================
    if (!this.state.projectType) {
      this.state.projectType = detectProjectType(this.workDir);
      this.log(`Detected project type: ${this.state.projectType}`);
      saveState(this.state);
    } else {
      this.log(`Project type: ${this.state.projectType}`);
    }

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
      if (specContent || description) {
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

    // Spawn research agent
    const prompt = buildResearchPrompt(this.state, specContent);
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
      defaultBranch = this.github.getDefaultBranch();
    } catch {
      return;
    }

    let advanced = 0;
    for (const phase of this.state.buildPhases) {
      if (phase.status === 'done') continue;

      const buildDonePath = join(this.workDir, PHASES_DIR, `phase-${phase.number}`, 'build.done');
      if (!existsSync(buildDonePath)) continue;

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
    if (!jiraTicketKey && this.jira.isEnabled()) {
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

    // Create phase branch
    const phaseBranch = `phase-${phaseNumber}/${slugify(phase.name)}`;
    phase.branchName = phaseBranch;
    const defaultBranch = this.github.getDefaultBranch();
    this.github.createBranch(phaseBranch, defaultBranch);

    // Ensure .gitignore exists (prevents node_modules/.next etc from being committed)
    this.ensureGitignore();

    // ==================== BUILD ====================
    // Only skip build if THIS phase has actually been built (check for build.done artifact)
    // Guard: if phase-plan.json is newer than build.done, the plan was regenerated and build.done is stale
    const buildDonePath = join(this.workDir, PHASES_DIR, `phase-${phaseNumber}`, 'build.done');
    let phaseAlreadyBuilt = existsSync(buildDonePath);
    if (phaseAlreadyBuilt) {
      try {
        const planPath = join(this.workDir, PHASE_PLAN_FILE);
        if (existsSync(planPath)) {
          const planMtime = statSync(planPath).mtimeMs;
          const buildDoneMtime = statSync(buildDonePath).mtimeMs;
          if (planMtime > buildDoneMtime) {
            this.log(`Phase ${phaseNumber} build.done is stale (older than phase-plan.json), removing...`);
            unlinkSync(buildDonePath);
            phaseAlreadyBuilt = false;
          }
        }
      } catch { /* ignore stat errors */ }
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

    // ==================== AAR PHASE ====================
    // Run after QA passes, before merge. Failures here are hard gates — the
    // user-facing markdown at docs/aar/phase-N.md MUST exist or the phase fails.
    await this.runAAR(phaseNumber);

    // Commit any uncommitted changes
    if (this.github.hasUncommittedChanges()) {
      this.log(`Committing uncommitted changes before merge...`);
      this.github.commit(`chore: commit remaining changes after phase ${phaseNumber} AAR`);
      if (phase.prNumber) {
        this.github.push(phaseBranch);
      }
    }

    // Re-read default branch right before merge (repo now guaranteed to exist)
    const mergeTarget = this.github.getDefaultBranch();

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
        merged = this.github.mergeBranch(phaseBranch, mergeTarget);
        if (merged && this.github.hasRemote()) {
          this.github.push(mergeTarget);
        }
      }
    } else {
      // No PR (no remote) — merge locally
      this.log(`Merging ${phaseBranch} into ${mergeTarget} locally (no PR)`);
      merged = this.github.mergeBranch(phaseBranch, mergeTarget);
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

    phase.buildAttempts = (phase.buildAttempts || 0) + 1;
    saveState(this.state);

    // Build prompt and run session
    const prompt = buildBuildPhasePrompt(this.state, phase);
    const startTime = Date.now();

    const buildDoneFile = `${PHASES_DIR}/phase-${phase.number}/build.done`;
    const result = await this.spawner.run({
      cwd: this.workDir,
      prompt,
      timeoutMs: PHASE_BUILD_TIMEOUT_MS,
      sessionName: `build-phase-${phase.number}`,
      doneFile: buildDoneFile,
      model: getModelForPhase('build')
    });

    const durationMs = Date.now() - startTime;
    phase.buildTime = this.formatDuration(durationMs);
    saveState(this.state);

    // Check gate
    let gateResult = this.gates.checkPhaseBuild(phase.number);

    // Retry once if failed
    if (!gateResult.passed && phase.buildAttempts < MAX_BUILD_RETRIES) {
      this.log(`Build gate failed for phase ${phase.number}, retrying...`);
      phase.buildAttempts++;
      saveState(this.state);

      await this.spawner.run({
        cwd: this.workDir,
        prompt,
        timeoutMs: PHASE_BUILD_TIMEOUT_MS,
        sessionName: `build-phase-${phase.number}-retry`,
        doneFile: buildDoneFile,
        model: getModelForPhase('build')
      });

      gateResult = this.gates.checkPhaseBuild(phase.number);
    }

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

    this.state.qaAttempts = 0;
    saveState(this.state);

    const MAX_FAST_QA_ATTEMPTS = 3;
    let qaPass = false;
    let preFixSha: string | null = null;
    let prevBlockerCount: number | null = null;

    while (!qaPass && this.state.qaAttempts < MAX_FAST_QA_ATTEMPTS) {
      this.state.qaAttempts++;
      const attempt = this.state.qaAttempts;
      saveState(this.state);

      this.log(`\n--- QA Attempt ${attempt}/${MAX_FAST_QA_ATTEMPTS} (combined session) ---\n`);
      auditQA(phaseNumber, attempt, 'started');

      // Capture git diff stat vs the phase's base branch so the verdict agent can
      // ground-check whether the work claimed actually landed. Without this, QA
      // happily passes a 14-ticket "all done" claim against an empty diff.
      const baseRef = this.github.getDefaultBranch();
      let diffStat = '';
      try {
        diffStat = execSync(`git diff ${baseRef}...HEAD --stat`, { encoding: 'utf-8' }).trim();
      } catch { /* base branch may not exist on first run */ }

      // Single combined QA session: smoke + functional + verdict
      const qaResult = await this.spawner.run({
        cwd: this.workDir,
        prompt: buildQaCombinedPrompt(this.state, phaseNumber, attempt, diffStat, baseRef),
        timeoutMs: QA_TIMEOUT_MS,
        sessionName: `qa-combined-${attempt}`,
        doneFile: `${QA_DIR}/phase-${phaseNumber}/verdict-${attempt}.done`,
        model: getModelForPhase('qa-functional') // Sonnet for combined QA
      });

      if (qaResult.rateLimited) {
        this.log('Rate limit detected — waiting 5 minutes before retry...');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
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
      if (smokeResult.rateLimited) {
        this.log('Rate limit detected — waiting 5 minutes before retry...');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
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
      if (qaResults.some(r => r.rateLimited)) {
        this.log('Rate limit detected in QA sessions — waiting 5 minutes before retry...');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
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
   * Ensure a .gitignore exists in the work directory based on detected project type.
   * Prevents node_modules, build artifacts, etc. from being committed.
   */
  private ensureGitignore(): void {
    const gitignorePath = join(this.workDir, '.gitignore');

    if (existsSync(gitignorePath)) return;

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

    // Next.js
    if (/next/i.test(stack)) {
      lines.push('', '# Next.js', '.next/', '.vercel/');
    }

    // Nuxt
    if (/nuxt/i.test(stack)) {
      lines.push('', '# Nuxt', '.nuxt/', '.output/');
    }

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

    lines.push('');

    writeFileSync(gitignorePath, lines.join('\n'));
    this.log('Created .gitignore based on project type');
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
Generated by turkey-enterprise-v3 (phase-based)
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

    // 2. Quick smoke test — verify --print and --dangerously-skip-permissions work
    const testResult = await this.spawner.run({
      cwd: this.workDir,
      prompt: 'Write the word "TURKEY" to stdout and nothing else.',
      timeoutMs: 30000,
      sessionName: 'preflight',
    });

    if (testResult.exitCode !== 0 || testResult.stdout.length < 3) {
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
