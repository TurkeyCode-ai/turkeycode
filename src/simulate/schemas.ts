/**
 * Simulation Driven Development (SDD): the contracts.
 *
 * A SimSpec says who visits the built app, what they should come away with,
 * and how many of them must get there. It is derived from the project's spec
 * and it is what the SDD engine runs. The engine is a separate program (see
 * engine.ts); SimReport is what it writes back.
 */

export interface SimPersona {
  id: string;
  /** One line: who this is. */
  archetype: string;
  role: string;
  experience: string;
  alreadyUses: string[];
  /** Where they came from and the only thing they saw before landing. */
  arrivalSource: string;
  arrivalSaw: string;
  needs: string[];
  objections: string[];
  readingWpm: number;
  /** Share of body text this visitor skips, 0 to 1. */
  skimRate: number;
  /**
   * Held-back personas are never shown to whoever revises the build. They
   * catch a build that was fitted to the working personas.
   */
  holdout: boolean;
}

export interface SimQuestion {
  id: string;
  /** Asked after the visit, with the page gone. */
  ask: string;
  /** What a passing answer must state. Each element is one checkable claim. */
  required: string[];
  /** Share of visitors who must pass, 0 to 1. */
  threshold: number;
}

export interface SimTask {
  id: string;
  /** Short name of the task, for reports. */
  goal: string;
  /** What the visitor is asked to try, in plain words. */
  instruction: string;
  /** What the screen shows once the task is done. A judge checks the final screen against this. */
  outcome: string;
  /** Share of visitors who must complete it, 0 to 1. */
  threshold: number;
  /** How long a visitor keeps trying before giving up. */
  patienceSeconds: number;
}

export interface SimSpec {
  /** The outcome, in one sentence. */
  goal: string;
  entryFrom: string;
  viewports: ('mobile' | 'desktop')[];
  timeBudgetSeconds: number;
  personas: SimPersona[];
  questions: SimQuestion[];
  /** Things a first-time visitor should be able to do. A page with nothing to do has none. */
  tasks: SimTask[];
}

export type SimVerdict = 'pass' | 'not met' | 'inside the noise' | 'incomplete';

export interface SimInterval {
  passed: number;
  n: number;
  rate: number | null;
  lower: number;
  upper: number;
}

export interface SimQuestionResult {
  id: string;
  threshold: number;
  interval: SimInterval;
  verdict: 'met' | 'not met' | 'inside the noise';
}

export interface SimSetResult {
  set: 'working' | 'holdout';
  runs: number;
  questions: SimQuestionResult[];
  met: boolean;
  /** Working set only: what a reviser may see. */
  missedElements?: { question: string; element: string; missedRate: number }[];
  stoppedIn?: Record<string, number>;
  failingAnswers?: { question: string; answer: string; judgeNote: string }[];
}

/** The engine's reports/<run>.json. Only the fields turkeycode relies on are checked. */
export interface SimReport {
  schema: 'sdd-report/1';
  run: string;
  verdict: SimVerdict;
  calibrated: boolean;
  /** Present when the engine could not finish. */
  error?: string;
  runs: { completed: number; failed: number; budgetHit: boolean };
  costUsd: number;
  blockedRequests?: { origin: string; count: number }[];
  working: SimSetResult;
  holdout: SimSetResult;
}

/** One part of a simulation: the reading of the entry page, or one task. */
export interface SimPart {
  kind: 'read' | 'task';
  /** "read", or the task id. */
  id: string;
  /** For a task: what visitors were asked to try. */
  goal?: string;
  instruction?: string;
  report: SimReport;
}

/** What turkeycode stores for a whole simulation. */
export interface SimRunReport {
  schema: 'turkeycode-simulation/1';
  run: string;
  startedAt: string;
  finishedAt: string;
  target: string;
  verdict: SimVerdict;
  calibrated: boolean;
  costUsd: number;
  parts: SimPart[];
  /** Tasks in the spec that were not run, with the reason. */
  skipped: { id: string; reason: string }[];
  blockedRequests: { origin: string; count: number }[];
}

/** One verdict for the whole run. Every part must pass for the run to pass. */
export function combineVerdicts(verdicts: SimVerdict[]): SimVerdict {
  if (verdicts.length === 0) return 'incomplete';
  if (verdicts.includes('incomplete')) return 'incomplete';
  if (verdicts.includes('not met')) return 'not met';
  if (verdicts.includes('inside the noise')) return 'inside the noise';
  return 'pass';
}

// ============================================================================
// Validation. Hand-written: these are the only schemas in turkeycode, and the
// errors go back to a person, so they name the field.
// ============================================================================

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

class Issues {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(issues: Issues, path: string, value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') { issues.add(path, 'must be text'); return ''; }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) issues.add(path, `must be ${min} to ${max} characters`);
  return trimmed;
}

function slug(issues: Issues, path: string, value: unknown): string {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    issues.add(path, 'must be lowercase letters, digits and dashes, starting with a letter');
    return '';
  }
  return value;
}

function num(issues: Issues, path: string, value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    issues.add(path, `must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    return min;
  }
  return value;
}

function list<T>(issues: Issues, path: string, value: unknown, min: number, max: number, each: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) { issues.add(path, 'must be a list'); return []; }
  if (value.length < min || value.length > max) issues.add(path, `must have ${min} to ${max} items`);
  return value.map((item, i) => each(item, `${path}[${i}]`));
}

function unique(issues: Issues, name: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) issues.add(name, 'ids must be unique');
}

/** Checks a generated simulation spec. Throws one error that lists every problem. */
export function parseSimSpec(input: unknown): SimSpec {
  const issues = new Issues();
  if (!isObject(input)) throw new Error('The simulation spec must be a JSON object.');

  const personas = list(issues, 'personas', input.personas, 4, 8, (item, path): SimPersona => {
    const p = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(path, 'must be an object');
    if (typeof p.holdout !== 'boolean') issues.add(`${path}.holdout`, 'must be true or false');
    return {
      id: slug(issues, `${path}.id`, p.id),
      archetype: text(issues, `${path}.archetype`, p.archetype, 5, 200),
      role: text(issues, `${path}.role`, p.role, 2, 200),
      experience: text(issues, `${path}.experience`, p.experience, 2, 200),
      alreadyUses: list(issues, `${path}.alreadyUses`, p.alreadyUses, 1, 5, (v, q) => text(issues, q, v, 1, 200)),
      arrivalSource: text(issues, `${path}.arrivalSource`, p.arrivalSource, 2, 100),
      arrivalSaw: text(issues, `${path}.arrivalSaw`, p.arrivalSaw, 2, 300),
      needs: list(issues, `${path}.needs`, p.needs, 2, 3, (v, q) => text(issues, q, v, 3, 300)),
      objections: list(issues, `${path}.objections`, p.objections, 2, 3, (v, q) => text(issues, q, v, 3, 300)),
      readingWpm: num(issues, `${path}.readingWpm`, p.readingWpm, 150, 400, true),
      skimRate: num(issues, `${path}.skimRate`, p.skimRate, 0.2, 0.85),
      holdout: p.holdout === true,
    };
  });

  const questions = list(issues, 'questions', input.questions, 2, 4, (item, path): SimQuestion => {
    const q = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(path, 'must be an object');
    return {
      id: slug(issues, `${path}.id`, q.id),
      ask: text(issues, `${path}.ask`, q.ask, 10, 300),
      required: list(issues, `${path}.required`, q.required, 1, 3, (v, p) => text(issues, p, v, 5, 300)),
      threshold: num(issues, `${path}.threshold`, q.threshold, 0.3, 0.95),
    };
  });

  const tasks = list(issues, 'tasks', input.tasks ?? [], 0, 3, (item, path): SimTask => {
    const t = isObject(item) ? item : {};
    if (!isObject(item)) issues.add(path, 'must be an object');
    return {
      id: slug(issues, `${path}.id`, t.id),
      goal: text(issues, `${path}.goal`, t.goal, 5, 200),
      instruction: text(issues, `${path}.instruction`, t.instruction, 10, 400),
      outcome: text(issues, `${path}.outcome`, t.outcome, 10, 400),
      threshold: num(issues, `${path}.threshold`, t.threshold, 0.2, 0.95),
      patienceSeconds: num(issues, `${path}.patienceSeconds`, t.patienceSeconds, 30, 300, true),
    };
  });

  const viewports = list(issues, 'viewports', input.viewports, 1, 2, (v, path) => {
    if (v !== 'mobile' && v !== 'desktop') issues.add(path, 'must be "mobile" or "desktop"');
    return v as 'mobile' | 'desktop';
  });

  const spec: SimSpec = {
    goal: text(issues, 'goal', input.goal, 20, 500),
    entryFrom: text(issues, 'entryFrom', input.entryFrom, 3, 200),
    viewports: [...new Set(viewports)],
    timeBudgetSeconds: num(issues, 'timeBudgetSeconds', input.timeBudgetSeconds, 15, 180, true),
    personas,
    questions,
    tasks,
  };

  const working = personas.filter(p => !p.holdout).length;
  if (working < 3) issues.add('personas', 'at least 3 must have holdout: false');
  if (personas.length - working < 1) issues.add('personas', 'at least 1 must have holdout: true');
  unique(issues, 'personas', personas.map(p => p.id));
  unique(issues, 'questions', questions.map(q => q.id));
  unique(issues, 'tasks', tasks.map(t => t.id));

  if (issues.list.length > 0) {
    throw new Error(`The simulation spec is not usable:\n${issues.list.map(i => `  - ${i}`).join('\n')}`);
  }
  return spec;
}

const VERDICTS: SimVerdict[] = ['pass', 'not met', 'inside the noise', 'incomplete'];

function parseSet(issues: Issues, path: string, value: unknown, set: 'working' | 'holdout'): SimSetResult {
  const s = isObject(value) ? value : {};
  if (!isObject(value)) issues.add(path, 'is missing');
  const questions = Array.isArray(s.questions) ? s.questions : [];
  if (!Array.isArray(s.questions)) issues.add(`${path}.questions`, 'must be a list');
  for (const [i, q] of questions.entries()) {
    const ok = isObject(q) && typeof q.id === 'string' && typeof q.threshold === 'number'
      && isObject(q.interval) && typeof q.interval.passed === 'number' && typeof q.interval.n === 'number'
      && typeof q.interval.lower === 'number' && typeof q.interval.upper === 'number'
      && typeof q.verdict === 'string';
    if (!ok) issues.add(`${path}.questions[${i}]`, 'is not a question result');
  }
  return { ...(s as object), set, runs: typeof s.runs === 'number' ? s.runs : 0, questions: questions as SimQuestionResult[], met: s.met === true };
}

/** Checks the engine's report. Throws if it is not a report this version understands. */
export function parseSimReport(input: unknown): SimReport {
  const issues = new Issues();
  if (!isObject(input)) throw new Error('The simulation report must be a JSON object.');
  if (input.schema !== 'sdd-report/1') issues.add('schema', `expected "sdd-report/1", got ${JSON.stringify(input.schema)}`);
  if (!VERDICTS.includes(input.verdict as SimVerdict)) issues.add('verdict', `not a verdict: ${JSON.stringify(input.verdict)}`);
  if (typeof input.costUsd !== 'number') issues.add('costUsd', 'must be a number');
  const runs = isObject(input.runs) ? input.runs : {};
  if (typeof runs.completed !== 'number' || typeof runs.failed !== 'number') issues.add('runs', 'must have completed and failed counts');
  const working = parseSet(issues, 'working', input.working, 'working');
  const holdout = parseSet(issues, 'holdout', input.holdout, 'holdout');
  if (issues.list.length > 0) {
    throw new Error(`The simulation report is not usable:\n${issues.list.map(i => `  - ${i}`).join('\n')}`);
  }
  return {
    ...(input as object),
    schema: 'sdd-report/1',
    run: String(input.run ?? ''),
    verdict: input.verdict as SimVerdict,
    calibrated: input.calibrated === true,
    error: typeof input.error === 'string' ? input.error : undefined,
    runs: { completed: runs.completed as number, failed: runs.failed as number, budgetHit: runs.budgetHit === true },
    costUsd: input.costUsd as number,
    blockedRequests: Array.isArray(input.blockedRequests) ? input.blockedRequests as { origin: string; count: number }[] : [],
    working,
    holdout,
  };
}
