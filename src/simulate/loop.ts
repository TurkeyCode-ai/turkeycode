/**
 * The revise loop: simulate, revise the app, verify the build, simulate again,
 * and keep a change only when the score improved.
 *
 * This file is the decision logic only. Git, the fix session and the build
 * check are passed in, so the rules can be tested without any of them.
 *
 * The rules:
 * - The reviser only ever sees working-set results. When the working set
 *   passes and the held-back set does not, it is told that and nothing else.
 * - A change that breaks the build is reverted before it is ever simulated.
 * - A change is kept only if the working-set score improved. Otherwise the
 *   branch goes back to where it was.
 * - It stops on a pass, when the simulation budget is spent, at the iteration
 *   limit, or after two iterations in a row that improved nothing.
 */

import type { SimRunReport } from './schemas';

export const DEFAULT_LOOP_ITERATIONS = 3;
export const DEFAULT_LOOP_BUDGET_USD = 20;
/** Iterations in a row without an improvement before the loop gives up. */
export const PLATEAU_AFTER = 2;

export type SimulationAttempt =
  | { status: 'done'; report: SimRunReport; markdownPath: string }
  | { status: 'skipped' | 'failed'; reason: string };

export interface ReviseInput {
  iteration: number;
  /** The simulation the app is being revised against. Working-set detail only is used. */
  report: SimRunReport;
  /** True when every working threshold is met and the held-back visitors still disagree. */
  holdoutDisagrees: boolean;
}

export interface LoopDeps {
  /** Run a simulation with this much budget left. */
  simulate(budgetUsd: number): Promise<SimulationAttempt>;
  /** Run one fix session and commit what it changed. Returns false when it changed nothing. */
  revise(input: ReviseInput): Promise<boolean>;
  /** The deterministic build check. */
  verify(): Promise<boolean>;
  /** The current commit, and a way back to one. */
  head(): string;
  revertTo(sha: string): void;
  log(line: string): void;
}

export interface LoopOptions {
  maxIterations?: number;
  /** Cap on simulation spend across the whole loop, at list prices. */
  budgetUsd?: number;
}

export type LoopStop = 'pass' | 'budget' | 'iterations' | 'plateau' | 'no-baseline';

export interface LoopIteration {
  iteration: number;
  outcome: 'kept' | 'reverted: no improvement' | 'reverted: build broke' | 'reverted: simulation did not finish' | 'no change';
  /** Working-set shortfall before and after, when a simulation ran. */
  before: number;
  after?: number;
}

export interface LoopResult {
  stop: LoopStop;
  /** Why there is no baseline, when stop is "no-baseline". */
  reason?: string;
  baselineStatus: 'done' | 'skipped' | 'failed';
  iterations: LoopIteration[];
  kept: number;
  /** The simulation of the app as the loop left it. */
  final: SimRunReport | null;
  finalMarkdownPath?: string;
  spentUsd: number;
}

/**
 * How far the working set is from its thresholds. Two numbers, compared in
 * order: the total by which pass rates fall short, then the total by which the
 * low ends of the intervals fall short. The second keeps the score able to
 * improve after every rate has cleared, which is exactly when "met" is still
 * out of reach.
 */
export function workingScore(report: SimRunReport): { shortfall: number; lowerGap: number } {
  let shortfall = 0;
  let lowerGap = 0;
  for (const part of report.parts) {
    for (const q of part.report.working.questions) {
      shortfall += Math.max(0, q.threshold - (q.interval.rate ?? 0));
      lowerGap += Math.max(0, q.threshold - q.interval.lower);
    }
  }
  return { shortfall, lowerGap };
}

const EPSILON = 1e-9;

/** True when `candidate` measures the same parts as `best` and scores better on the working set. */
export function improved(candidate: SimRunReport, best: SimRunReport): boolean {
  const ids = (r: SimRunReport) => r.parts.map(p => p.id).sort().join('|');
  // Fewer parts measured is not an improvement, it is a smaller exam.
  if (ids(candidate) !== ids(best)) return false;
  const a = workingScore(candidate);
  const b = workingScore(best);
  if (a.shortfall < b.shortfall - EPSILON) return true;
  if (a.shortfall > b.shortfall + EPSILON) return false;
  return a.lowerGap < b.lowerGap - EPSILON;
}

export function workingMet(report: SimRunReport): boolean {
  return report.parts.length > 0 && report.parts.every(p => p.report.working.met);
}

export async function runReviseLoop(deps: LoopDeps, options: LoopOptions = {}): Promise<LoopResult> {
  const maxIterations = options.maxIterations ?? DEFAULT_LOOP_ITERATIONS;
  const budgetUsd = options.budgetUsd ?? DEFAULT_LOOP_BUDGET_USD;
  const iterations: LoopIteration[] = [];
  let spent = 0;

  const baseline = await deps.simulate(budgetUsd);
  if (baseline.status !== 'done') {
    return { stop: 'no-baseline', reason: baseline.reason, baselineStatus: baseline.status, iterations, kept: 0, final: null, spentUsd: 0 };
  }
  spent += baseline.report.costUsd;
  let best = baseline.report;
  let bestPath = baseline.markdownPath;
  let kept = 0;
  let stale = 0;

  const done = (stop: LoopStop): LoopResult => ({
    stop, baselineStatus: 'done', iterations, kept, final: best, finalMarkdownPath: bestPath, spentUsd: Math.round(spent * 10000) / 10000,
  });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (best.verdict === 'pass') return done('pass');
    if (spent >= budgetUsd) return done('budget');
    if (stale >= PLATEAU_AFTER) return done('plateau');

    const before = workingScore(best).shortfall;
    const snapshot = deps.head();
    deps.log(`--- Revise iteration ${iteration}/${maxIterations} ---`);

    const changed = await deps.revise({ iteration, report: best, holdoutDisagrees: workingMet(best) });
    if (!changed) {
      deps.log('The fix session changed nothing.');
      iterations.push({ iteration, outcome: 'no change', before });
      stale++;
      continue;
    }

    if (!(await deps.verify())) {
      deps.log('The change broke the build. Reverting it.');
      deps.revertTo(snapshot);
      iterations.push({ iteration, outcome: 'reverted: build broke', before });
      stale++;
      continue;
    }

    const attempt = await deps.simulate(Math.max(0.01, budgetUsd - spent));
    if (attempt.status !== 'done') {
      deps.log(`The simulation of the change did not finish (${attempt.reason}). Reverting it.`);
      deps.revertTo(snapshot);
      iterations.push({ iteration, outcome: 'reverted: simulation did not finish', before });
      stale++;
      continue;
    }
    spent += attempt.report.costUsd;
    const after = workingScore(attempt.report).shortfall;

    if (improved(attempt.report, best)) {
      // A change can also be kept when the pass rates tie and only the margins of error tightened.
      // Saying the shortfall "went from 0.57 to 0.57" reads as a mistake, so say what happened.
      deps.log(before.toFixed(2) === after.toFixed(2)
        ? `Kept: the working-set shortfall is unchanged at ${after.toFixed(2)}, and the margins of error tightened.`
        : `Kept: the working-set shortfall went from ${before.toFixed(2)} to ${after.toFixed(2)}.`);
      best = attempt.report;
      bestPath = attempt.markdownPath;
      kept++;
      stale = 0;
      iterations.push({ iteration, outcome: 'kept', before, after });
    } else {
      deps.log(`No improvement (shortfall ${before.toFixed(2)} before, ${after.toFixed(2)} after). Reverting the change.`);
      deps.revertTo(snapshot);
      iterations.push({ iteration, outcome: 'reverted: no improvement', before, after });
      stale++;
    }
  }

  if (best.verdict === 'pass') return done('pass');
  if (stale >= PLATEAU_AFTER) return done('plateau');
  return done('iterations');
}

export function describeStop(result: LoopResult): string {
  switch (result.stop) {
    case 'pass': return 'every threshold is met, for the visitors and the held-back visitors';
    case 'budget': return 'the simulation budget was spent';
    case 'iterations': return 'the iteration limit was reached';
    case 'plateau': return `${PLATEAU_AFTER} iterations in a row improved nothing`;
    case 'no-baseline': return `the first simulation did not produce a report (${result.reason ?? 'no reason given'})`;
  }
}
