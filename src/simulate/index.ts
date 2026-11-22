/**
 * turkeycode simulate: simulated visitors use the app that was just built, and
 * it is scored against thresholds derived from the spec.
 *
 * Report only. Nothing here changes the app. The scores are uncalibrated: they
 * compare versions of this app with each other and predict nothing about real
 * visitors, and every report says so.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { SPECS_FILE, SIMULATION_DIR } from '../constants';
import { detectProjectTypeStrict } from '../detect-project-type';
import type { ProjectType } from '../types';
import { dockerComposeAvailable, startLocalApp, type LocalApp } from './app';
import { ENGINE_INSTALL_HINT, findEngine, runEngine, type Engine, type EngineResult, type EngineRunOptions } from './engine';
import { generateSimSpec, loadSimSpec, type SessionRunner } from './generate';
import {
  combineVerdicts,
  type SimPart, type SimReport, type SimRunReport, type SimSetResult, type SimSpec, type SimVerdict,
} from './schemas';
import { writeSimWorkdir } from './workdir';

export const DEFAULT_RUNS_PER_PERSONA = 10;
export const DEFAULT_BUDGET_USD = 5;

export const UNCALIBRATED_NOTE =
  'Not calibrated. These are simulated visitors that have not been checked against real people. ' +
  'The scores compare versions of this app with each other. They are not a prediction about real visitors.';

/** Project types with nothing for a visitor to open in a browser. */
const NOT_A_WEB_APP: ProjectType[] = ['cli', 'library', 'desktop', 'mobile', 'game-godot', 'embedded', 'legacy', 'web-api'];

/**
 * Where a project's simulation lives: outside the repo, so the held-back
 * personas are never in reach of a session that builds or revises the app.
 */
export function simHome(cwd: string, root: string = join(homedir(), '.turkeycode', 'sim')): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* keep the path as given */ }
  const name = basename(real).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8);
  return join(root, `${name}-${hash}`);
}

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `sim-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export interface SimulateOptions {
  runsPerPersona?: number;
  budgetUsd?: number;
  /** Design the study again even if this project already has one. */
  regenerate?: boolean;
  /** Environment for the copy of the app (it does not get the project's .env). */
  env?: Record<string, string>;
  runId?: string;
  log?: (line: string) => void;
}

/** Everything that touches the outside world, so tests can replace it. */
export interface SimulateDeps {
  findEngine: () => Engine | null;
  hasClaudeCli: () => boolean;
  hasDocker: () => boolean;
  projectType: (cwd: string) => ProjectType;
  runner: SessionRunner;
  startApp: (cwd: string, options: { home: string; env?: Record<string, string>; log: (line: string) => void }) => Promise<LocalApp>;
  runEngine: (engine: Engine, options: EngineRunOptions, hooks: { onLine?: (line: string) => void }) => Promise<EngineResult>;
  simRoot?: string;
}

export function defaultDeps(runner: SessionRunner): SimulateDeps {
  return {
    findEngine: () => findEngine(),
    hasClaudeCli: () => {
      try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
    },
    hasDocker: dockerComposeAvailable,
    projectType: detectProjectTypeStrict,
    runner,
    startApp: startLocalApp,
    runEngine,
  };
}

export type SimulateOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'done'; report: SimRunReport; reportPath: string; markdownPath: string };

/**
 * Runs a simulation of the project in `cwd`. Never throws for a missing tool
 * or an app that will not start: those come back as skipped or failed, because
 * a simulation is a measurement and must not break the run that asked for it.
 */
export async function runSimulation(cwd: string, options: SimulateOptions, deps: SimulateDeps): Promise<SimulateOutcome> {
  const log = options.log ?? (line => console.log(line));
  const runsPerPersona = options.runsPerPersona ?? DEFAULT_RUNS_PER_PERSONA;
  const budgetUsd = options.budgetUsd ?? DEFAULT_BUDGET_USD;

  const engine = deps.findEngine();
  if (!engine) return { status: 'skipped', reason: `The SDD engine is not installed. Install it with: ${ENGINE_INSTALL_HINT}` };
  if (!deps.hasClaudeCli()) return { status: 'skipped', reason: 'The SDD engine calls models through the claude CLI, which is not installed or not on PATH.' };

  const type = deps.projectType(cwd);
  if (NOT_A_WEB_APP.includes(type)) {
    return { status: 'skipped', reason: `Simulated visitors need a web app to open, and this project is "${type}".` };
  }
  if (!deps.hasDocker()) return { status: 'skipped', reason: 'Docker is not running. The simulation runs the app as a throwaway copy in Docker.' };

  const home = simHome(cwd, deps.simRoot);
  let spec: SimSpec | null = null;
  try {
    spec = options.regenerate ? null : loadSimSpec(home);
  } catch (err) {
    log(`  The stored simulation design is not usable and will be replaced: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!spec) {
    const specPath = join(cwd, SPECS_FILE);
    if (!existsSync(specPath)) {
      return { status: 'skipped', reason: `There is no spec at ${SPECS_FILE} to derive visitors from. Run: turkeycode scope "<description>"` };
    }
    log('  Designing the study from the spec (who visits, what they are asked)...');
    try {
      spec = await generateSimSpec({
        home,
        projectName: basename(cwd),
        specText: readFileSync(specPath, 'utf-8'),
        runner: deps.runner,
        log,
      });
    } catch (err) {
      return { status: 'failed', reason: (err as Error).message };
    }
  }
  const working = spec.personas.filter(p => !p.holdout).length;
  log(`  Study: ${working} visitors, ${spec.personas.length - working} held back, ${spec.questions.length} questions, ${spec.tasks.length} tasks.`);

  let app: LocalApp;
  try {
    app = await deps.startApp(cwd, { home, env: options.env, log });
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }

  const run = options.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const parts: SimPart[] = [];
  const skipped: { id: string; reason: string }[] = [];
  let spent = 0;

  const pass = async (kind: 'read' | 'task', id: string, workdir: string): Promise<SimReport | null> => {
    const result = await deps.runEngine(
      engine,
      { workdir, target: app.url, run, runsPerPersona, budgetUsd: Math.max(0.01, budgetUsd - spent) },
      { onLine: line => log(`    ${line}`) }
    );
    if (!result.report) {
      skipped.push({ id, reason: result.error ?? 'the engine left no report' });
      return null;
    }
    spent += result.report.costUsd;
    return result.report;
  };

  try {
    log(`  Visitors are reading the entry page (${app.url})...`);
    const readDir = join(home, 'read');
    writeSimWorkdir(readDir, 'read', spec, runsPerPersona);
    const read = await pass('read', 'read', readDir);
    if (read) parts.push({ kind: 'read', id: 'read', report: read });

    for (const task of spec.tasks) {
      if (spent >= budgetUsd) {
        skipped.push({ id: task.id, reason: 'the budget was spent before this task' });
        continue;
      }
      log(`  Visitors are trying: ${task.goal}`);
      // Each task starts from an empty app, so one task's visitors do not leave data for the next.
      await app.reset();
      const taskDir = join(home, `task-${task.id}`);
      writeSimWorkdir(taskDir, `task-${task.id}`, spec, runsPerPersona, task);
      const report = await pass('task', task.id, taskDir);
      if (report) parts.push({ kind: 'task', id: task.id, goal: task.goal, instruction: task.instruction, report });
    }
  } catch (err) {
    skipped.push({ id: 'simulation', reason: (err as Error).message });
  } finally {
    app.stop();
  }

  if (parts.length === 0) {
    return { status: 'failed', reason: `No part of the simulation produced a report. ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}` };
  }

  const blocked = new Map<string, number>();
  for (const part of parts) {
    for (const b of part.report.blockedRequests ?? []) blocked.set(b.origin, (blocked.get(b.origin) ?? 0) + b.count);
  }
  const verdicts: SimVerdict[] = parts.map(p => p.report.verdict);
  // A part that did not run means the whole simulation cannot be called complete.
  if (skipped.length > 0) verdicts.push('incomplete');

  const report: SimRunReport = {
    schema: 'turkeycode-simulation/1',
    run,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: app.url,
    verdict: combineVerdicts(verdicts),
    calibrated: parts.every(p => p.report.calibrated),
    costUsd: Math.round(spent * 10000) / 10000,
    parts: parts.map(p => ({ ...p, report: forProject(p.report) })),
    skipped,
    blockedRequests: [...blocked].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count),
  };

  const outDir = join(cwd, SIMULATION_DIR);
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `${run}.json`);
  const markdownPath = join(outDir, `${run}.md`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(markdownPath, renderMarkdown(report));
  return { status: 'done', report, reportPath, markdownPath };
}

/**
 * What may be written inside the project, where a session that revises the app
 * can read it: the working set in full, the held-back set as rates only. The
 * engine already strips its report this way; this does not rely on that.
 */
export function forProject(report: SimReport): SimReport {
  const holdout: SimSetResult = {
    set: 'holdout',
    runs: report.holdout.runs,
    questions: report.holdout.questions,
    met: report.holdout.met,
  };
  return { ...report, holdout };
}

const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);

function rows(part: SimPart): { label: string; set: string; rate: string; interval: string; threshold: string; verdict: string }[] {
  const out = [];
  for (const set of [part.report.working, part.report.holdout]) {
    for (const q of set.questions) {
      out.push({
        label: part.kind === 'task' ? `task: ${part.goal ?? part.id}` : q.id,
        set: set.set === 'working' ? 'visitors' : 'held back',
        rate: `${pct(q.interval.rate)} (${q.interval.passed}/${q.interval.n})`,
        interval: `${pct(q.interval.lower)} to ${pct(q.interval.upper)}`,
        threshold: pct(q.threshold),
        verdict: q.verdict,
      });
    }
  }
  return out;
}

export function renderMarkdown(report: SimRunReport): string {
  const lines: string[] = [];
  lines.push(`# Simulation ${report.run}`, '');
  lines.push(`**Verdict: ${report.verdict}.** A threshold is met only when the low end of its 95% interval clears it, for the visitors and for the held-back visitors.`, '');
  if (!report.calibrated) lines.push(`**${UNCALIBRATED_NOTE}**`, '');
  lines.push(`- Cost at list prices: $${report.costUsd.toFixed(2)}`);
  if (report.blockedRequests.length > 0) {
    lines.push(`- Outside requests refused, so visitors saw the app without them: ${report.blockedRequests.map(b => `${b.origin} (${b.count})`).join(', ')}`);
  }
  for (const s of report.skipped) lines.push(`- Not run: ${s.id}. ${s.reason}`);
  lines.push('', '| What | Who | Passed | 95% interval | Threshold | Verdict |', '|---|---|---|---|---|---|');
  for (const part of report.parts) {
    for (const r of rows(part)) lines.push(`| ${r.label} | ${r.set} | ${r.rate} | ${r.interval} | ${r.threshold} | ${r.verdict} |`);
  }
  for (const part of report.parts) {
    const w = part.report.working;
    const title = part.kind === 'task' ? `Task: ${part.goal ?? part.id}` : 'Reading the entry page';
    lines.push('', `## ${title}`, '');
    if (part.instruction) lines.push(`Visitors were asked: "${part.instruction}"`, '');
    if (w.missedElements?.length) {
      lines.push('Missed most:', ...w.missedElements.map(m => `- ${m.question}: "${m.element}" missed by ${pct(m.missedRate)}`), '');
    }
    if (w.stoppedIn && Object.keys(w.stoppedIn).length > 0) {
      lines.push('Where visitors were when they stopped:', ...Object.entries(w.stoppedIn).map(([name, x]) => `- ${name}: ${pct(x)}`), '');
    }
    if (w.failingAnswers?.length) {
      lines.push('A sample of what went wrong:', ...w.failingAnswers.map(f => `- [${f.question}] ${f.answer}\n  - Judge: ${f.judgeNote}`), '');
    }
  }
  return lines.join('\n') + '\n';
}

/** The summary printed to the terminal. */
export function renderSummary(report: SimRunReport): string[] {
  const table = report.parts.flatMap(rows);
  const width = (key: 'label' | 'set' | 'rate' | 'interval' | 'threshold', head: string) => Math.max(head.length, ...table.map(r => r[key].length));
  const w = { label: width('label', 'WHAT'), set: width('set', 'WHO'), rate: width('rate', 'PASSED'), interval: width('interval', '95% INTERVAL'), threshold: width('threshold', 'NEEDS') };
  const out: string[] = [];
  out.push(`  ${'WHAT'.padEnd(w.label)}  ${'WHO'.padEnd(w.set)}  ${'PASSED'.padEnd(w.rate)}  ${'95% INTERVAL'.padEnd(w.interval)}  ${'NEEDS'.padEnd(w.threshold)}  VERDICT`);
  out.push('  ' + '-'.repeat(w.label + w.set + w.rate + w.interval + w.threshold + 28));
  for (const r of table) {
    out.push(`  ${r.label.padEnd(w.label)}  ${r.set.padEnd(w.set)}  ${r.rate.padEnd(w.rate)}  ${r.interval.padEnd(w.interval)}  ${r.threshold.padEnd(w.threshold)}  ${r.verdict}`);
  }
  out.push('');
  out.push(`  Verdict: ${report.verdict}   Cost at list prices: $${report.costUsd.toFixed(2)}`);
  for (const s of report.skipped) out.push(`  Not run: ${s.id}. ${s.reason}`);
  if (report.blockedRequests.length > 0) {
    out.push(`  Outside requests refused: ${report.blockedRequests.map(b => b.origin).join(', ')}`);
  }
  if (!report.calibrated) out.push('', `  ${UNCALIBRATED_NOTE}`);
  return out;
}
