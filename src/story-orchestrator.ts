/**
 * Story/bug mode: turn a plain-language prompt into a points-estimated Jira ticket,
 * burn it down against its epic, then hand off to the existing ticket-run flow.
 *
 *   prompt -> estimate session (classify + size) -> create Jira ticket (typed + pointed
 *   + epic-linked) -> report epic burndown -> runTicket(newKey)
 *
 * State lives under ~/.turkeycode/stories/{slug}/ so it doesn't collide with `.turkey/`
 * (project state) or ~/.turkeycode/tickets/ (ticket-run state).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  createJiraClient,
  JiraClient,
  isJiraConfigured,
  EpicBurndown,
} from './jira';
import { createSpawner, Spawner } from './spawner';
import { slugify } from './repos';
import { buildTicketEstimatePrompt } from './prompts/ticket-estimate';
import { createTicketOrchestrator } from './ticket-orchestrator';
import { getModelForPhase } from './constants';
import { audit } from './audit';

const STORIES_ROOT = join(homedir(), '.turkeycode', 'stories');
const ESTIMATE_TIMEOUT_MS = 5 * 60 * 1000;
const FIBONACCI = [1, 2, 3, 5, 8, 13];

export interface Estimate {
  issueType: 'Bug' | 'Story';
  title: string;
  description: string;
  points: number;
  rationale: string;
}

export interface StoryRunOptions {
  /** Force the issue type instead of letting the model classify. */
  forceType?: 'Bug' | 'Story';
  /** Override the model's point estimate. */
  pointsOverride?: number;
  /** Parent epic key. Enables burndown reporting. */
  epicKey?: string;
  /** Override the epic's point budget for the burndown (else read from the epic). */
  budgetOverride?: number | null;
  /** Estimate only. Do not create the ticket or run anything. */
  dryRun?: boolean;
  /** Create + point the ticket but skip the ticket-run flow. Defaults to running. */
  run?: boolean;
  /** Pass-through to the ticket run: stop after triage. */
  triageOnly?: boolean;
  verbose?: boolean;
  manifestPath?: string;
  mcpConfig?: string;
}

/** Snap an arbitrary number to the nearest Fibonacci point value, ties → smaller. */
export function nearestFibonacci(n: number): number {
  if (!Number.isFinite(n)) return 3;
  let best = FIBONACCI[0];
  let bestDist = Math.abs(n - best);
  for (const f of FIBONACCI) {
    const dist = Math.abs(n - f);
    if (dist < bestDist) {
      best = f;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Validate + normalize a raw estimate JSON blob into a safe Estimate.
 * Pure (no IO) so it can be unit-tested. Throws if there's no usable title.
 */
export function normalizeEstimate(raw: unknown, forceType?: 'Bug' | 'Story'): Estimate {
  const obj = (raw ?? {}) as Record<string, unknown>;

  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!title) {
    throw new Error('Estimate is missing a title.');
  }

  let issueType: 'Bug' | 'Story';
  if (forceType) {
    issueType = forceType;
  } else {
    issueType = obj.issueType === 'Bug' ? 'Bug' : 'Story';
  }

  const rawPoints = typeof obj.points === 'number' ? obj.points : Number(obj.points);
  const points = nearestFibonacci(rawPoints);

  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';

  return { issueType, title, description, points, rationale };
}

/** Render an epic burndown as a one-block human/Jira-comment string. */
export function formatBurndown(epicKey: string, bd: EpicBurndown, thisStoryPoints: number): string {
  const lines: string[] = [];
  const budget = bd.budget === null ? '?' : String(bd.budget);
  const remaining = bd.remaining === null ? '?' : String(bd.remaining);
  lines.push(`Epic ${epicKey} burndown: ${bd.used}/${budget} pts used, ${remaining} remaining (${bd.childCount} child issue(s)).`);
  lines.push(`This story adds ${thisStoryPoints} pt(s).`);
  if (bd.budget === null) {
    lines.push(`(Epic has no point budget set — showing committed points only.)`);
  }
  return lines.join('\n');
}

export class StoryOrchestrator {
  private jira: JiraClient;
  private spawner: Spawner;
  private verbose: boolean;
  private mcpConfig: string | undefined;

  constructor(options: { verbose?: boolean; mcpConfig?: string } = {}) {
    if (!isJiraConfigured()) {
      throw new Error('Jira is not configured. Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN.');
    }
    if (!process.env.JIRA_PROJECT) {
      throw new Error('Set JIRA_PROJECT — story mode creates tickets and needs a target project key.');
    }
    this.verbose = options.verbose ?? false;
    this.mcpConfig = options.mcpConfig ?? process.env.TURKEYCODE_MCP_CONFIG;
    this.jira = createJiraClient();
    this.spawner = createSpawner({ verbose: this.verbose });
  }

  async createAndRun(description: string, opts: StoryRunOptions): Promise<void> {
    audit('story_started', { details: { epic: opts.epicKey ?? null } });

    // 1. Estimate (classify + size) via a short Claude session.
    const estimate = await this.runEstimate(description, opts.forceType);
    if (typeof opts.pointsOverride === 'number') {
      estimate.points = nearestFibonacci(opts.pointsOverride);
    }

    console.log('');
    console.log(`[story] Estimate:`);
    console.log(`[story]   Type:   ${estimate.issueType}`);
    console.log(`[story]   Title:  ${estimate.title}`);
    console.log(`[story]   Points: ${estimate.points}${opts.pointsOverride != null ? ' (overridden)' : ''}`);
    if (estimate.rationale) console.log(`[story]   Why:    ${estimate.rationale}`);

    // 2. Dry run stops here — nothing is written to Jira.
    if (opts.dryRun) {
      console.log('');
      console.log(`[story] --dry-run: not creating the ticket. Estimate above.`);
      return;
    }

    // 3. Create the ticket (typed + pointed + epic-linked).
    const key = await this.jira.createTicket({
      summary: estimate.title,
      description: estimate.description,
      issueType: estimate.issueType,
      storyPoints: estimate.points,
      epicKey: opts.epicKey,
    });
    if (!key) {
      throw new Error('Failed to create the Jira ticket. See the [jira] error above.');
    }
    console.log('');
    console.log(`[story] Created ${estimate.issueType} ${key} (${estimate.points} pts)`);
    if (process.env.JIRA_HOST) {
      console.log(`[story]   ${`https://${process.env.JIRA_HOST}/browse/${key}`}`);
    }
    audit('story_ticket_created', { details: { ticket: key, points: estimate.points, epic: opts.epicKey ?? null } });

    // 4. Burndown against the epic (read-and-report; never mutates the epic).
    if (opts.epicKey) {
      const bd = await this.jira.getEpicBurndown(opts.epicKey);
      if (bd) {
        const effective: EpicBurndown =
          opts.budgetOverride != null
            ? { ...bd, budget: opts.budgetOverride, remaining: opts.budgetOverride - bd.used }
            : bd;
        const summary = formatBurndown(opts.epicKey, effective, estimate.points);
        console.log('');
        summary.split('\n').forEach((l) => console.log(`[story] ${l}`));
        await this.jira.addComment(key, `turkeycode (automated):\n\n${summary}`);
      } else {
        console.warn(`[story] Could not read burndown for epic ${opts.epicKey}.`);
      }
    }

    // 5. Hand off to the ticket-run flow unless told not to.
    if (opts.run === false) {
      console.log('');
      console.log(`[story] --no-run: ticket ${key} created and pointed. Run it later with: turkeycode run-ticket ${key}`);
      return;
    }

    console.log('');
    console.log(`[story] Handing ${key} to the ticket-run flow...`);
    const orch = createTicketOrchestrator({
      verbose: this.verbose,
      manifestPath: opts.manifestPath,
      mcpConfig: this.mcpConfig,
      triageOnly: opts.triageOnly,
    });
    await orch.runTicket(key);
  }

  private async runEstimate(description: string, forceType?: 'Bug' | 'Story'): Promise<Estimate> {
    const dir = this.prepareStoryDir(description);
    const outputPath = join(dir, 'estimate.json');
    const doneFile = join(dir, 'estimate.done');
    if (existsSync(doneFile)) writeFileSync(doneFile, ''); // truncate so a stale run can't short-circuit

    const prompt = buildTicketEstimatePrompt({ description, forceType, outputPath, doneFile });

    console.log(`[story] Estimating (classify + size)...`);
    const result = await this.spawner.run({
      cwd: dir,
      prompt,
      timeoutMs: ESTIMATE_TIMEOUT_MS,
      sessionName: 'estimate',
      doneFile: 'estimate.done',
      model: getModelForPhase('qa-smoke') ?? 'haiku',
      mcpConfig: this.mcpConfig,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Estimate session failed (exit ${result.exitCode}).`);
    }
    if (!existsSync(outputPath)) {
      throw new Error(`Estimate session did not produce ${outputPath}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(outputPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Estimate output was not valid JSON: ${(err as Error).message}`);
    }
    return normalizeEstimate(parsed, forceType);
  }

  private prepareStoryDir(description: string): string {
    const slug = slugify(description).slice(0, 40) || 'story';
    const dir = join(STORIES_ROOT, `${Date.now()}-${slug}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

export function createStoryOrchestrator(options?: { verbose?: boolean; mcpConfig?: string }): StoryOrchestrator {
  return new StoryOrchestrator(options);
}
