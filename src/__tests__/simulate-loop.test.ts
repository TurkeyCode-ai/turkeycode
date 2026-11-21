import { describe, it, expect } from 'vitest';
import {
  describeStop, improved, runReviseLoop, workingMet, workingScore,
  type LoopDeps, type ReviseInput, type SimulationAttempt,
} from '../simulate/loop';
import { buildSimulateFixPrompt, simulateFixFiles } from '../prompts/simulate-fix';
import type { SimPart, SimRunReport, SimVerdict } from '../simulate/schemas';

// ============================================================================
// Reports by pass rate, so a test reads as "the score went from X to Y"
// ============================================================================

function part(id: string, rate: number, threshold = 0.8, n = 20): SimPart {
  const passed = Math.round(rate * n);
  const lower = Math.max(0, rate - 0.15);
  const verdict = lower >= threshold ? 'met' as const : rate + 0.15 < threshold ? 'not met' as const : 'inside the noise' as const;
  const questions = [{ id: id === 'read' ? 'what' : 'task', threshold, interval: { passed, n, rate, lower, upper: Math.min(1, rate + 0.15) }, verdict }];
  return {
    kind: id === 'read' ? 'read' : 'task',
    id,
    goal: id === 'read' ? undefined : 'Add a plant',
    instruction: id === 'read' ? undefined : 'Add a plant you own.',
    report: {
      schema: 'sdd-report/1', run: 'r', verdict: 'inside the noise', calibrated: false,
      runs: { completed: n, failed: 0, budgetHit: false }, costUsd: 1,
      working: {
        set: 'working', runs: n, questions, met: verdict === 'met',
        missedElements: [{ question: 'what', element: 'it tracks watering', missedRate: 1 - rate }],
        stoppedIn: { hero: 1 },
        failingAnswers: [{ question: 'what', answer: 'A plant shop.', judgeNote: 'No mention of watering.' }],
      },
      holdout: { set: 'holdout', runs: 8, questions: [{ ...questions[0], interval: { passed: 3, n: 8, rate: 0.375, lower: 0.14, upper: 0.69 } }], met: false },
    },
  };
}

function report(rates: Record<string, number>, verdict: SimVerdict = 'not met', costUsd = 1): SimRunReport {
  return {
    schema: 'turkeycode-simulation/1', run: 'sim', startedAt: '', finishedAt: '', target: 'http://127.0.0.1:1',
    verdict, calibrated: false, costUsd, parts: Object.entries(rates).map(([id, rate]) => part(id, rate)), skipped: [], blockedRequests: [],
  };
}

const done = (r: SimRunReport, name = 'report.md'): SimulationAttempt => ({ status: 'done', report: r, markdownPath: name });

interface Script {
  /** One entry per simulation, in order. The first is the baseline. */
  simulations: SimulationAttempt[];
  /** Per iteration: did the fix session change anything, and does the build still pass. */
  changes?: boolean[];
  builds?: boolean[];
}

function harness(script: Script) {
  const events: string[] = [];
  const revises: ReviseInput[] = [];
  const budgets: number[] = [];
  let head = 0;
  let sims = 0;
  let iter = 0;
  const deps: LoopDeps = {
    simulate: async budget => {
      budgets.push(budget);
      events.push('simulate');
      return script.simulations[Math.min(sims++, script.simulations.length - 1)];
    },
    revise: async input => {
      revises.push(input);
      const changed = script.changes?.[iter] ?? true;
      events.push(changed ? 'revise' : 'revise:nothing');
      if (changed) head++;
      return changed;
    },
    verify: async () => {
      const ok = script.builds?.[iter] ?? true;
      events.push(ok ? 'verify:ok' : 'verify:broken');
      return ok;
    },
    head: () => `c${head}`,
    revertTo: sha => { events.push(`revert:${sha}`); head = Number(sha.slice(1)); },
    log: () => {},
  };
  // The loop asks revise → verify → simulate once per iteration; advance after each.
  const wrapped: LoopDeps = {
    ...deps,
    revise: async input => {
      iter = input.iteration - 1;
      return deps.revise(input);
    },
  };
  return { deps: wrapped, events, revises, budgets, head: () => `c${head}` };
}

// ============================================================================
// The score
// ============================================================================

describe('simulate/loop: the score', () => {
  it('measures how far the working set falls short of its thresholds', () => {
    expect(workingScore(report({ read: 0.5, 'add-plant': 0.9 })).shortfall).toBeCloseTo(0.3);
    expect(workingScore(report({ read: 0.9 })).shortfall).toBe(0);
  });

  it('can still improve after every rate has cleared, through the interval', () => {
    const a = report({ read: 0.85 });
    const b = report({ read: 0.92 });
    expect(workingScore(a).shortfall).toBe(0);
    expect(workingScore(b).shortfall).toBe(0);
    expect(improved(b, a)).toBe(true);
    expect(improved(a, b)).toBe(false);
  });

  it('is not improved by an equal score, or by measuring fewer things', () => {
    expect(improved(report({ read: 0.5 }), report({ read: 0.5 }))).toBe(false);
    expect(improved(report({ read: 0.9 }), report({ read: 0.5, 'add-plant': 0.4 }))).toBe(false);
  });

  it('never looks at the held-back set', () => {
    const a = report({ read: 0.5 });
    const b = report({ read: 0.5 });
    b.parts[0].report.holdout.questions[0].interval = { passed: 8, n: 8, rate: 1, lower: 0.68, upper: 1 };
    expect(improved(b, a)).toBe(false);
    expect(workingMet(report({ read: 0.99 }))).toBe(true);
    expect(workingMet(report({ read: 0.8 }))).toBe(false);
  });
});

// ============================================================================
// The loop
// ============================================================================

describe('simulate/loop: keep or revert', () => {
  it('keeps a change that improved the score and stops when everything passes', async () => {
    const h = harness({ simulations: [done(report({ read: 0.5 })), done(report({ read: 0.99 }, 'pass'), 'better.md')] });
    const result = await runReviseLoop(h.deps);
    expect(h.events).toEqual(['simulate', 'revise', 'verify:ok', 'simulate']);
    expect(result.stop).toBe('pass');
    expect(result.kept).toBe(1);
    expect(result.final?.verdict).toBe('pass');
    expect(result.finalMarkdownPath).toBe('better.md');
    expect(h.head()).toBe('c1');
  });

  it('reverts a change that did not improve the score, back to the exact commit', async () => {
    const h = harness({ simulations: [done(report({ read: 0.5 }), 'base.md'), done(report({ read: 0.45 })), done(report({ read: 0.5 }))] });
    const result = await runReviseLoop(h.deps);
    expect(h.events.slice(0, 5)).toEqual(['simulate', 'revise', 'verify:ok', 'simulate', 'revert:c0']);
    expect(result.kept).toBe(0);
    expect(result.stop).toBe('plateau');
    expect(result.iterations.map(i => i.outcome)).toEqual(['reverted: no improvement', 'reverted: no improvement']);
    expect(result.finalMarkdownPath).toBe('base.md');
    expect(h.head()).toBe('c0');
  });

  it('reverts a change that broke the build without spending a simulation on it', async () => {
    const h = harness({ simulations: [done(report({ read: 0.5 }))], builds: [false, false] });
    const result = await runReviseLoop(h.deps);
    expect(h.events).toEqual(['simulate', 'revise', 'verify:broken', 'revert:c0', 'revise', 'verify:broken', 'revert:c0']);
    expect(result.iterations.every(i => i.outcome === 'reverted: build broke')).toBe(true);
    expect(result.spentUsd).toBe(1);
  });

  it('reverts when the simulation of a change does not finish', async () => {
    const h = harness({ simulations: [done(report({ read: 0.5 })), { status: 'failed', reason: 'the copy did not start' }] });
    const result = await runReviseLoop(h.deps);
    expect(result.iterations[0].outcome).toBe('reverted: simulation did not finish');
    expect(h.head()).toBe('c0');
  });

  it('counts a fix session that changed nothing, without verifying or simulating', async () => {
    const h = harness({ simulations: [done(report({ read: 0.5 }))], changes: [false, false] });
    const result = await runReviseLoop(h.deps);
    expect(h.events).toEqual(['simulate', 'revise:nothing', 'revise:nothing']);
    expect(result.stop).toBe('plateau');
  });

  it('builds on a kept change: the next comparison is against the new best', async () => {
    const h = harness({
      simulations: [done(report({ read: 0.4 })), done(report({ read: 0.6 })), done(report({ read: 0.55 })), done(report({ read: 0.7 }))],
    });
    const result = await runReviseLoop(h.deps, { maxIterations: 3 });
    expect(result.iterations.map(i => i.outcome)).toEqual(['kept', 'reverted: no improvement', 'kept']);
    expect(result.kept).toBe(2);
    expect(result.stop).toBe('iterations');
    expect(h.revises[1].report.parts[0].report.working.questions[0].interval.rate).toBe(0.6);
    expect(h.revises[2].report.parts[0].report.working.questions[0].interval.rate).toBe(0.6);
  });
});

describe('simulate/loop: when it stops', () => {
  it('does nothing when the app already passes', async () => {
    const h = harness({ simulations: [done(report({ read: 0.99 }, 'pass'))] });
    const result = await runReviseLoop(h.deps);
    expect(h.events).toEqual(['simulate']);
    expect(result.stop).toBe('pass');
  });

  it('stops when the simulation budget is spent, and hands each simulation what is left', async () => {
    const h = harness({ simulations: [done(report({ read: 0.4 }, 'not met', 6)), done(report({ read: 0.6 }, 'not met', 6))] });
    const result = await runReviseLoop(h.deps, { budgetUsd: 10 });
    expect(h.budgets).toEqual([10, 4]);
    expect(result.stop).toBe('budget');
    expect(result.spentUsd).toBe(12);
    expect(result.kept).toBe(1);
  });

  it('reports why when the first simulation gives no report, and revises nothing', async () => {
    const h = harness({ simulations: [{ status: 'skipped', reason: 'The SDD engine is not installed.' }] });
    const result = await runReviseLoop(h.deps);
    expect(result).toMatchObject({ stop: 'no-baseline', baselineStatus: 'skipped', kept: 0, final: null });
    expect(h.events).toEqual(['simulate']);
    expect(describeStop(result)).toContain('The SDD engine is not installed.');
  });

  it('tells the reviser when its visitors are satisfied and the held-back ones are not', async () => {
    const h = harness({ simulations: [done(report({ read: 0.99 }, 'inside the noise')), done(report({ read: 0.99 }, 'pass'))] });
    await runReviseLoop(h.deps);
    expect(h.revises[0].holdoutDisagrees).toBe(true);

    const other = harness({ simulations: [done(report({ read: 0.5 })), done(report({ read: 0.99 }, 'pass'))] });
    await runReviseLoop(other.deps);
    expect(other.revises[0].holdoutDisagrees).toBe(false);
  });
});

// ============================================================================
// What the reviser is shown
// ============================================================================

describe('prompts/simulate-fix', () => {
  const input = { projectName: 'plants', iteration: 2, report: report({ read: 0.5, 'add-plant': 0.4 }), holdoutDisagrees: false };

  it('shows working-set findings and the task visitors were given', () => {
    const prompt = buildSimulateFixPrompt(input);
    expect(prompt).toContain('"it tracks watering" missed by 50%');
    expect(prompt).toContain('A plant shop.');
    expect(prompt).toContain('Visitors were asked: "Add a plant you own."');
    expect(prompt).toContain('50% (10/20)');
  });

  it('shows nothing about the held-back visitors: no rates, no counts', () => {
    const prompt = buildSimulateFixPrompt(input);
    expect(prompt).not.toContain('3/8');
    expect(prompt).not.toContain('38%');
    expect(prompt.toLowerCase()).not.toContain('holdout');
    expect(prompt).not.toContain('held-back');
  });

  it('says only that an unseen group disagrees, when that is the case', () => {
    const prompt = buildSimulateFixPrompt({ ...input, holdoutDisagrees: true });
    expect(prompt).toContain('a second group of visitors you are not shown did not get there');
    expect(prompt).not.toContain('3/8');
  });

  it('forbids gaming the measurement and editing the spec', () => {
    const prompt = buildSimulateFixPrompt(input);
    expect(prompt).toContain('Fix the app, not the measurement');
    expect(prompt).toContain('Do not edit `.turkey/reference/specs.md`');
    expect(prompt).toContain('Do not commit');
    expect(simulateFixFiles(2)).toEqual({ notes: '.turkey/simulation/fix-2.md', done: '.turkey/simulation/fix-2.done' });
  });
});
