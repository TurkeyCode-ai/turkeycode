/**
 * Writes the SDD engine's work directory for one part of a simulation:
 *
 *   <dir>/spec.yaml
 *   <dir>/personas/working/<id>.yaml
 *   <dir>/personas/holdout/<id>.yaml
 *
 * The files are written as JSON. JSON is valid YAML, so the engine reads them
 * as they are.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SimPersona, SimSpec, SimTask } from './schemas';

export function writeSimWorkdir(dir: string, experiment: string, spec: SimSpec, runsPerPersona: number, task?: SimTask): void {
  // Personas are rewritten from the spec every time so a removed persona cannot linger.
  rmSync(join(dir, 'personas'), { recursive: true, force: true });
  mkdirSync(join(dir, 'personas', 'working'), { recursive: true });
  mkdirSync(join(dir, 'personas', 'holdout'), { recursive: true });

  const engine = task ? engineTaskSpec(experiment, spec, task, runsPerPersona) : engineSpec(experiment, spec, runsPerPersona);
  writeFileSync(join(dir, 'spec.yaml'), JSON.stringify(engine, null, 2) + '\n');
  for (const persona of spec.personas) {
    const file = join(dir, 'personas', persona.holdout ? 'holdout' : 'working', `${persona.id}.yaml`);
    writeFileSync(file, JSON.stringify(enginePersona(persona), null, 2) + '\n');
  }
}

/** The engine's spec for reading the entry page. */
export function engineSpec(experiment: string, spec: SimSpec, runsPerPersona: number) {
  return {
    experiment,
    kind: 'comprehension',
    goal: spec.goal,
    entry: { from: spec.entryFrom, viewports: spec.viewports },
    reader: {
      time_budget_seconds: spec.timeBudgetSeconds,
      answers_from: 'what_was_seen',
      may_scroll_back: false,
      // Visitors see each screen they scrolled past, with body text blurred.
      screenshots: true,
    },
    personas: { runs_per_persona: runsPerPersona },
    questions: spec.questions.map(q => ({ id: q.id, ask: q.ask, rubric: { required: q.required } })),
    pass: Object.fromEntries(spec.questions.map(q => [`${q.id}_rate`, q.threshold])),
    // Report only: the engine measures and changes nothing.
    budget: { iterations: 0 },
  };
}

/**
 * The engine's spec for one task. Visitors are asked to try it and act on the
 * app. Success is the prose outcome, checked by the engine's judge from the
 * final screen. The visitor model is never shown it.
 */
export function engineTaskSpec(experiment: string, spec: SimSpec, task: SimTask, runsPerPersona: number) {
  return {
    experiment,
    kind: 'task',
    goal: task.goal,
    entry: { from: spec.entryFrom, viewports: spec.viewports },
    task: { goal: task.goal, instruction: task.instruction, success: { outcome: task.outcome } },
    visitor: { patience_seconds: task.patienceSeconds, max_steps: 25, screenshots: true },
    personas: { runs_per_persona: runsPerPersona },
    pass: { task_rate: task.threshold },
    budget: { iterations: 0 },
  };
}

export function enginePersona(persona: SimPersona) {
  return {
    id: persona.id,
    archetype: persona.archetype,
    profile: {
      role: persona.role,
      experience: persona.experience,
      tech_comfort: 'not stated',
      already_uses: persona.alreadyUses,
    },
    arrival: { source: persona.arrivalSource, saw: persona.arrivalSaw },
    needs: persona.needs,
    objections: persona.objections,
    dials: { reading_wpm: persona.readingWpm, skim_rate: persona.skimRate },
  };
}
