#!/usr/bin/env node

/**
 * turkey-enterprise-v3 CLI
 * Phase-based orchestrator for Claude Code build workflows
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from deploy/ directory (relative to project root)
config({ path: resolve(__dirname, '..', 'deploy', '.env') });

import { Command } from 'commander';
import { createOrchestrator } from './orchestrator';
import { loadState, resetState, canResume } from './state';
import { createGates } from './gates';
import { setStrictQA } from './constants';

const program = new Command();

program
  .name('turkey-enterprise-v3')
  .description('Phase-based orchestrator for Claude Code build workflows')
  .version('3.0.0');

// ==================== RUN COMMAND ====================
program
  .command('run')
  .description('Run the full orchestration loop')
  .argument('<description>', 'Project description')
  .option('-j, --jira <project>', 'Jira project key')
  .option('-g, --github <repo>', 'GitHub repo (owner/repo)')
  .option('-s, --spec <file>', 'Spec file path')
  .option('-v, --verbose', 'Verbose output')
  .option('-w, --allow-warnings', 'Allow warnings in QA (only blockers must be zero)')
  .action(async (description: string, options) => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           TURKEY ENTERPRISE V3 ORCHESTRATOR              ║');
    console.log('║                                                          ║');
    console.log('║  Phase-based builds. Parallel QA. Hard gates.           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Set QA strictness based on flag
    if (options.allowWarnings) {
      setStrictQA(false);
      console.log('Warning threshold: RELAXED (blockers only, warnings allowed)');
      console.log('');
    }

    const orchestrator = createOrchestrator({
      verbose: options.verbose,
      jiraProject: options.jira,
      githubRepo: options.github,
      specFile: options.spec
    });

    try {
      await orchestrator.run(description, {
        jiraProject: options.jira,
        githubRepo: options.github,
        specFile: options.spec
      });
    } catch (err) {
      console.error('Orchestration failed:', err);
      process.exit(1);
    }
  });

// ==================== STATUS COMMAND ====================
program
  .command('status')
  .description('Show current orchestration status')
  .action(() => {
    const state = loadState();

    console.log('');
    console.log('=== ORCHESTRATION STATUS ===');
    console.log('');
    console.log(`Project: ${state.projectDescription || '(not set)'}`);
    console.log(`Phase: ${state.currentPhase}`);
    console.log(`Step: ${state.currentStep || '(none)'}`);
    console.log('');

    if (state.buildPhases.length > 0) {
      console.log(`Build Phases: ${state.completedPhases.length}/${state.buildPhases.length} completed`);
      console.log(`Current Build Phase: ${state.currentBuildPhaseNumber}`);
      console.log('');

      console.log('Phases:');
      for (const phase of state.buildPhases) {
        const icon = phase.status === 'done' ? '✓' :
                     phase.status === 'building' ? '⇒' :
                     phase.status === 'qa' ? '?' :
                     phase.status === 'fixing' ? '!' : ' ';
        console.log(`  [${icon}] Phase ${phase.number}: ${phase.name} (${phase.status})`);
        if (phase.buildAttempts > 0) {
          console.log(`      Build attempts: ${phase.buildAttempts}, QA attempts: ${phase.qaAttempts}`);
        }
        if (phase.lastQaVerdict) {
          console.log(`      Last QA verdict: ${phase.lastQaVerdict}`);
        }
      }
    }

    console.log('');
    console.log(`QA Attempts: ${state.qaAttempts}`);
    console.log(`Last QA Verdict: ${state.lastQaVerdict || '(none)'}`);
    console.log('');

    if (Object.keys(state.tech).length > 0) {
      console.log('Tech Context:');
      console.log(`  Backend: ${state.tech.backend || '(not set)'}`);
      console.log(`  Frontend: ${state.tech.frontend || '(not set)'}`);
      console.log(`  Database: ${state.tech.database || '(not set)'}`);
    }

    console.log('');
    console.log(`Started: ${state.startedAt}`);
    console.log(`Updated: ${state.lastUpdatedAt}`);
    console.log('');
  });

// ==================== RESET COMMAND ====================
program
  .command('reset')
  .description('Reset orchestration state')
  .option('-f, --force', 'Force reset without confirmation')
  .action((options) => {
    if (!options.force) {
      console.log('This will reset all orchestration state.');
      console.log('Use --force to confirm.');
      process.exit(1);
    }

    resetState();
    console.log('Orchestration state reset.');
  });

// ==================== GATE COMMAND ====================
program
  .command('gate')
  .description('Check a specific gate')
  .argument('<gate>', 'Gate to check (research, plan, phase-build, qa-smoke, qa-functional, qa-visual, qa-verdict, code-review, aar)')
  .option('-p, --phase <number>', 'Phase number (for phase-specific gates)', '1')
  .option('-a, --attempt <number>', 'Attempt number (for QA gates)', '1')
  .action((gate: string, options) => {
    const gates = createGates();
    const phaseNumber = parseInt(options.phase, 10);
    const attempt = parseInt(options.attempt, 10);

    let result;

    switch (gate) {
      case 'research':
        result = gates.checkResearch();
        break;
      case 'plan':
        result = gates.checkPlan();
        break;
      case 'phase-build':
        result = gates.checkPhaseBuild(phaseNumber);
        break;
      case 'qa-smoke':
        result = gates.checkQaSmoke(phaseNumber, attempt);
        break;
      case 'qa-functional':
        result = gates.checkQaFunctional(phaseNumber, attempt);
        break;
      case 'qa-visual':
        result = gates.checkQaVisual(phaseNumber, attempt);
        break;
      case 'qa-verdict':
        result = gates.checkQaVerdict(phaseNumber, attempt);
        break;
      case 'code-review':
        result = gates.checkCodeReview(phaseNumber);
        break;
      case 'aar':
        result = gates.checkAAR(phaseNumber);
        break;
      default:
        console.error(`Unknown gate: ${gate}`);
        console.log('Available gates: research, plan, phase-build, qa-smoke, qa-functional, qa-visual, qa-verdict, code-review, aar');
        process.exit(1);
    }

    console.log('');
    console.log(`=== GATE: ${result.gate} ===`);
    console.log(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
    console.log(`Time: ${result.timestamp}`);
    console.log('');

    for (const artifact of result.artifacts) {
      const status = artifact.valid ? '✓' : '✗';
      console.log(`  ${status} ${artifact.name}`);
      console.log(`    Path: ${artifact.path}`);
      console.log(`    Exists: ${artifact.exists}`);
      console.log(`    Valid: ${artifact.valid}`);
      if (artifact.validationError) {
        console.log(`    Error: ${artifact.validationError}`);
      }
    }

    console.log('');
    process.exit(result.passed ? 0 : 1);
  });

// ==================== RESUME COMMAND ====================
program
  .command('resume')
  .description('Resume from current state')
  .option('-v, --verbose', 'Verbose output')
  .option('-w, --allow-warnings', 'Allow warnings in QA (only blockers must be zero)')
  .action(async (options) => {
    if (!canResume()) {
      console.log('Nothing to resume. Use "turkey-enterprise-v3 run" to start.');
      process.exit(1);
    }

    // Set QA strictness based on flag
    if (options.allowWarnings) {
      setStrictQA(false);
      console.log('Warning threshold: RELAXED (blockers only, warnings allowed)');
    }

    const state = loadState();
    console.log(`Resuming from phase: ${state.currentPhase}`);
    console.log(`Build Phase: ${state.currentBuildPhaseNumber}`);
    console.log('');

    const orchestrator = createOrchestrator({
      verbose: options.verbose
    });

    try {
      await orchestrator.run(state.projectDescription, {});
    } catch (err) {
      console.error('Orchestration failed:', err);
      process.exit(1);
    }
  });

// ==================== LOGIN COMMAND ====================
program
  .command('login')
  .description('Authenticate with turkeycode.ai')
  .option('-t, --token <api-key>', 'API token for headless / CI login')
  .action(async (options) => {
    const { login } = await import('./deploy/auth');
    await login({ token: options.token });
  });

// ==================== DEPLOY COMMAND ====================
program
  .command('deploy')
  .description('Package and deploy the current project to turkeycode.ai')
  .option('-n, --name <subdomain>', 'Custom subdomain name')
  .option('-d, --domain <domain>', 'Custom domain (Pro+)')
  .option('-t, --tier <tier>', 'Explicit tier: free | starter | pro | business')
  .option('-e, --env <file>', 'Env file to inject (e.g. .env.production)')
  .option('--skip-build', 'Skip the build step')
  .action(async (options) => {
    const { requireAuth } = await import('./deploy/auth');
    const { detectProject } = await import('./deploy/detect');
    const { packageApp } = await import('./deploy/package');
    const { uploadAndDeploy } = await import('./deploy/upload');
    const { readFileSync, existsSync } = await import('fs');

    const cwd = process.cwd();

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                  TURKEY DEPLOY                           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // 1. Check auth
    const creds = requireAuth();
    console.log(`Authenticated as ${creds.email}`);
    console.log('');

    // 2. Detect project
    console.log('Detecting project...');
    let detection;
    try {
      detection = detectProject(cwd);
    } catch (err) {
      console.error(`Detection failed: ${(err as Error).message}`);
      process.exit(1);
    }

    const effectiveTier = options.tier ?? detection.tier;
    const effectiveName = options.name ?? detection.name;
    console.log(`  App:    ${effectiveName}`);
    console.log(`  Stack:  ${detection.stack}`);
    console.log(`  Tier:   ${effectiveTier} — ${detection.tierReason}`);
    console.log('');

    // Load env file if specified
    let envVars: Record<string, string> = {};
    if (options.env) {
      if (!existsSync(options.env)) {
        console.error(`Env file not found: ${options.env}`);
        process.exit(1);
      }
      const lines = readFileSync(options.env, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          envVars[key] = val;
        }
      }
      console.log(`Loaded ${Object.keys(envVars).length} env vars from ${options.env}`);
    }

    // 3. Package
    console.log('Packaging...');
    let pkg;
    try {
      pkg = await packageApp(detection, cwd, {
        skipBuild: options.skipBuild,
        envFile: options.env,
      });
    } catch (err) {
      console.error(`Packaging failed: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`  Package: ${pkg.sizeMB}MB`);
    console.log('');

    // 4. Upload and poll
    let result;
    try {
      result = await uploadAndDeploy(pkg.tarballPath, detection, creds.token, {
        name: effectiveName,
        tier: effectiveTier,
        env: envVars,
      });
    } catch (err) {
      console.error(`Deploy failed: ${(err as Error).message}`);
      process.exit(1);
    }

    console.log('');
    console.log(`  App:    ${effectiveName}`);
    console.log(`  Tier:   ${effectiveTier}`);
    console.log(`  Stack:  ${detection.stack}`);
    console.log(`  URL:    ${result.url}`);
    console.log('');
  });

// ==================== DELIVER COMMAND ====================
program
  .command('deliver')
  .description('Deliver a non-web project to your GitHub (CLI, library, desktop, mobile)')
  .option('-n, --name <name>', 'Repository name')
  .option('-d, --description <desc>', 'Repository description')
  .option('--public', 'Create a public repo (default: private)')
  .action(async (options) => {
    const { isGhAuthenticated, getGhUsername, deliverToUserGitHub } = await import('./deploy/github');
    const { detectProjectType } = await import('./detect-project-type');
    const cwd = process.cwd();

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                 TURKEY DELIVER                           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Check gh auth
    if (!isGhAuthenticated()) {
      console.error('❌ GitHub CLI not authenticated.');
      console.log('   Run: gh auth login');
      process.exit(1);
    }

    const username = getGhUsername();
    console.log(`Authenticated as ${username}`);

    // Detect project
    const projectType = detectProjectType(cwd);
    const { basename } = await import('path');
    const appName = options.name || basename(cwd);

    console.log(`  Project: ${appName}`);
    console.log(`  Type:    ${projectType}`);
    console.log('');

    const result = await deliverToUserGitHub({
      projectDir: cwd,
      appName,
      description: options.description,
      visibility: options.public ? 'public' : 'private',
    });

    if (result.repoUrl) {
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════╗');
      console.log('║  ✅ DELIVERED                                            ║');
      console.log('╚══════════════════════════════════════════════════════════╝');
      console.log('');
      console.log(`  Repo:     ${result.repoUrl}`);
      if (result.releaseUrl) {
        console.log(`  Release:  ${result.releaseUrl}`);
      }
      if (result.artifacts.length > 0) {
        console.log(`  Binaries: ${result.artifacts.length} platform(s)`);
      }
      console.log('');
    }
  });

// ==================== APPS COMMAND ====================
const appsCmd = program
  .command('apps')
  .description('Manage deployed apps');

appsCmd
  .command('list', { isDefault: true })
  .description('List all deployed apps')
  .action(async () => {
    const { requireAuth } = await import('./deploy/auth');
    const { listApps, printApps } = await import('./deploy/apps');
    const creds = requireAuth();
    try {
      const apps = await listApps(creds.token);
      printApps(apps);
    } catch (err) {
      console.error(`Failed to list apps: ${(err as Error).message}`);
      process.exit(1);
    }
  });

appsCmd
  .command('status [app-name]')
  .description('Show app health and status')
  .action(async (appName?: string) => {
    const { requireAuth } = await import('./deploy/auth');
    const { listApps, printApps, getAppStatus } = await import('./deploy/apps');
    const creds = requireAuth();
    try {
      if (appName) {
        const app = await getAppStatus(appName, creds.token);
        printApps([app]);
      } else {
        const apps = await listApps(creds.token);
        printApps(apps);
      }
    } catch (err) {
      console.error(`Failed to get status: ${(err as Error).message}`);
      process.exit(1);
    }
  });

appsCmd
  .command('logs <app-name>')
  .description('Tail logs for an app')
  .option('-n, --lines <number>', 'Number of log lines', '100')
  .action(async (appName: string, options) => {
    const { requireAuth } = await import('./deploy/auth');
    const { getAppLogs } = await import('./deploy/apps');
    const creds = requireAuth();
    try {
      const logs = await getAppLogs(appName, creds.token, parseInt(options.lines, 10));
      if (logs.length === 0) {
        console.log('No logs found.');
      } else {
        console.log(logs.join('\n'));
      }
    } catch (err) {
      console.error(`Failed to get logs: ${(err as Error).message}`);
      process.exit(1);
    }
  });

appsCmd
  .command('delete <app-name>')
  .description('Tear down a deployed app')
  .option('-f, --force', 'Skip confirmation')
  .action(async (appName: string, options) => {
    const { requireAuth } = await import('./deploy/auth');
    const { deleteApp } = await import('./deploy/apps');
    const creds = requireAuth();

    if (!options.force) {
      console.log(`This will permanently delete '${appName}' and all its data.`);
      console.log(`Use --force to confirm.`);
      process.exit(1);
    }

    try {
      await deleteApp(appName, creds.token);
      console.log(`✅ Deleted ${appName}`);
    } catch (err) {
      console.error(`Failed to delete app: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
