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

program.parse(process.argv);
