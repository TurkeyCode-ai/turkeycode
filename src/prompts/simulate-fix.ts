/**
 * Simulate-fix prompt builder: one session revises the app after simulated
 * visitors used it.
 *
 * It is given working-set results only. The held-back visitors, the study and
 * the judge live outside the project and are never described here: a reviser
 * that can see the referee tunes the app to the referee.
 */

import { SIMULATION_DIR, SPECS_FILE } from '../constants';
import { oneTurnRule } from './one-turn';
import type { SimPart, SimRunReport } from '../simulate/schemas';

const pct = (x: number | null): string => (x === null || Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);

/** What the reviser may know about one part: the working set, nothing else. */
function workingFindings(part: SimPart): string {
  const w = part.report.working;
  const lines: string[] = [];
  lines.push(part.kind === 'task' ? `### Task: ${part.goal ?? part.id}` : '### Reading the entry page');
  if (part.instruction) lines.push('', `Visitors were asked: "${part.instruction}"`);
  lines.push('', '| What | Passed | Needs |', '|---|---|---|');
  for (const q of w.questions) {
    lines.push(`| ${part.kind === 'task' ? 'completed the task' : q.id} | ${pct(q.interval.rate)} (${q.interval.passed}/${q.interval.n}) | ${pct(q.threshold)} |`);
  }
  if (w.missedElements?.length) {
    lines.push('', 'Missed most:', ...w.missedElements.map(m => `- ${m.question}: "${m.element}" missed by ${pct(m.missedRate)}`));
  }
  if (w.stoppedIn && Object.keys(w.stoppedIn).length > 0) {
    lines.push('', 'Where visitors were when they stopped:', ...Object.entries(w.stoppedIn).map(([name, x]) => `- ${name}: ${pct(x)}`));
  }
  if (w.failingAnswers?.length) {
    lines.push('', 'A sample of what went wrong:', ...w.failingAnswers.map(f => `- [${f.question}] ${f.answer}\n  - Judge: ${f.judgeNote}`));
  }
  return lines.join('\n');
}

export interface SimulateFixInput {
  projectName: string;
  iteration: number;
  report: SimRunReport;
  /** Every working threshold is met and the held-back visitors still disagree. */
  holdoutDisagrees: boolean;
}

export function simulateFixFiles(iteration: number): { notes: string; done: string } {
  return { notes: `${SIMULATION_DIR}/fix-${iteration}.md`, done: `${SIMULATION_DIR}/fix-${iteration}.done` };
}

export function buildSimulateFixPrompt(input: SimulateFixInput): string {
  const { notes, done } = simulateFixFiles(input.iteration);
  const findings = input.report.parts.map(workingFindings).join('\n\n');
  const holdoutNote = input.holdoutDisagrees
    ? `
## The visitors you can see are satisfied. Others are not.

Every threshold below is met for these visitors, but a second group of visitors you are not shown did not get there. That usually means the app was fitted to this group. Make it clearer for someone who arrives knowing less, wanting something slightly different, or reading faster. Do not add anything aimed at a particular kind of visitor.
`
    : '';

  return `
# REVISE AFTER SIMULATION: ${input.projectName} (iteration ${input.iteration})

## YOUR SINGLE JOB

Simulated first-time visitors used this app. Some did not understand it, or could not finish what they were asked to try. Change the app so that more of them would. Then stop.

The simulation will be run again on your change. The change is kept only if these visitors do better, and it is thrown away if the build breaks.
${holdoutNote}
## What happened

${findings}

## How to read this

- "Missed most" is a claim visitors could not state afterwards. Usually the app says it too late, too quietly, or not at all.
- "Where visitors were when they stopped" shows how far they got. Something important below where most stopped was not seen.
- A failed task means visitors could not find or finish it. Look at the path from the entry page: what the control is called, where it is, what happens after.
- Visitors skim. They read headings and the first words of things, and they leave when nothing speaks to why they came.

## Rules

- Fix the app, not the measurement. Do not write the rubric's wording into the page to be found. Say the true thing clearly where a real visitor would see it.
- Everything the app says must stay true to \`${SPECS_FILE}\`. Do not add a claim, a feature, a price or a promise the spec does not support.
- Do not stuff headings, repeat the same sentence in several places, or add text that only exists to be matched.
- Keep it working: the build and the existing tests must still pass. Run them.
- Prefer the smallest change that addresses what was missed. Moving, renaming and rewording usually beat adding.
- Do not edit \`${SPECS_FILE}\` or anything else under \`.turkey/\` except the two files below. Do not touch \`.turkey/state.json\`.
- Do not commit. The orchestrator commits what you changed.

## Deliverables

1. The changes to the app.
2. \`${notes}\`: a short list of what you changed and which finding each change answers.
3. \`${done}\` containing the single word DONE.

${oneTurnRule(`\`${done}\``, { completionGate: true })}
`;
}
