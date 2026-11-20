/**
 * Ticket-driven orchestration: fetch a Jira ticket, classify it, and either
 *   - non-coding: run research and post a comment back to the ticket
 *   - coding: delegate to the multi-repo build flow (added in a later step)
 *
 * Lives alongside the existing project-build Orchestrator. A ticket run is
 * distinct from a "build a new project from scratch" run — the state lives
 * under ~/.turkeycode/tickets/{KEY}/ so it doesn't collide with `.turkey/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { shrinkImageToFit } from './attachment-shrink';
import { createJiraClient, JiraClient, TicketDetail, isJiraConfigured, formatJiraDuration } from './jira';
import { createSpawner, Spawner } from './spawner';
import {
  loadRepoManifest,
  preflightRepos,
  syncBase,
  cutTicketBranch,
  repoHasCommits,
  rebaseOntoBase,
  stashUncommitted,
  continueRebase,
  abortRebase,
  pushBranch,
  parseBaseLocalSpec,
  resolveLocalBases,
  resolveLocalBase,
  headSha,
  BaseLocalSpec,
  renderBranchName,
  slugify,
  RepoEntry,
  RepoManifest,
  DEFAULT_MANIFEST_PATH,
} from './repos';
import { buildTicketTriagePrompt } from './prompts/ticket-triage';
import { buildTicketResearchPrompt } from './prompts/ticket-research';
import { buildTicketBuildPrompt } from './prompts/ticket-build';
import { buildMergeFixPrompt } from './prompts/merge-fix';
import { clearInFlight, listInFlight, markInFlight } from './ticket-inflight';
import { InFlightNeighbour } from './prompts/ticket-common';
import { buildTicketPlanPrompt } from './prompts/ticket-plan';
import { buildTicketReviewPrompt } from './prompts/ticket-review';
import { buildTicketFixPrompt } from './prompts/ticket-fix';
import { getModelForPhase, PHASE_BUILD_TIMEOUT_MS, FIX_TIMEOUT_MS } from './constants';
import { audit } from './audit';

const TICKETS_ROOT = join(homedir(), '.turkeycode', 'tickets');

const TRIAGE_TIMEOUT_MS = 5 * 60 * 1000;
const TICKET_RESEARCH_TIMEOUT_MS = 20 * 60 * 1000;
const TICKET_PLAN_TIMEOUT_MS = 30 * 60 * 1000;
const TICKET_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_REVIEW_ROUNDS = 2;

export interface TicketRunOptions {
  verbose?: boolean;
  /** Override manifest path (defaults to ~/.turkeycode/repos.yaml). */
  manifestPath?: string;
  /** Override MCP config path (else uses TURKEYCODE_MCP_CONFIG). */
  mcpConfig?: string;
  /** Skip the preflight dirty-tree check across repos. */
  allowDirty?: boolean;
  /** Stop after triage. No branches cut, no build session, no Jira comment/worklog. */
  triageOnly?: boolean;
  /** Model for the build session (default: the 'build' phase model). */
  buildModel?: string;
  /**
   * Deep tier: plan session before the build, then review → fix rounds before
   * anything is pushed. For bigger tickets where one build session isn't enough.
   */
  deep?: boolean;
  /** Deep tier: max review → fix rounds (default 2). */
  reviewRounds?: number;
  /**
   * Cut the ticket branch from a LOCAL ref and rebase onto it instead of
   * origin/<base>. Comma-separated `<ref>` (every scoped repo where it exists;
   * others keep origin/<base>) and/or `<repoPath>=<ref>` (that repo; must exist).
   */
  baseLocal?: string;
  /** Stop after review/fix (+ rebase): leave branches local, print branch + SHA, no push / Jira transition. */
  noPush?: boolean;
}

export interface ReviewFinding {
  severity: string;
  repo?: string;
  file?: string;
  line?: number;
  summary: string;
  fix?: string;
  /** `file:line` citations backing the finding. Required; uncited findings are dropped. */
  evidence?: string[];
}

/** A "checked and OK" claim the reviewer relied on, with its citations. */
export interface VerifiedClaim {
  claim: string;
  evidence: string[];
}

export interface ReviewResult {
  findings: ReviewFinding[];
  verified: VerifiedClaim[];
  /** Findings discarded for lacking a `file:line` citation. */
  droppedFindings: number;
  /** Verified claims discarded for lacking a `file:line` citation. */
  droppedVerified: number;
  /** False when nothing cited survived: the reviewer can't have checked anything, so it isn't "clean". */
  reviewed: boolean;
}

export interface TriageVerdict {
  classification: 'coding' | 'non-coding';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  summary: string;
  /** Exact manifest paths the triage session believes need code changes. Empty for non-coding. */
  repos: string[];
}

interface PhaseTimings {
  triage?: number;
  research?: number;
  plan?: number;
  build?: number;
  review?: number;
  fix?: number;
  merge_fix?: number;
  rebase_push?: number;
}

const IMAGE_MIME_PREFIX = 'image/';

export class TicketOrchestrator {
  private jira: JiraClient;
  private spawner: Spawner;
  private manifest: RepoManifest | null;
  private mcpConfig: string | undefined;
  private verbose: boolean;
  private triageOnly: boolean;
  private buildModel: string | undefined;
  private deep: boolean;
  private reviewRounds: number;
  private baseLocal: BaseLocalSpec | undefined;
  /** Repo path -> local ref for the current run (--base-local), handed to the review and fix prompts. */
  private currentLocalBases = new Map<string, string>();
  private noPush: boolean;
  /** Things the review/fix loop did that the person reading the ticket needs to know (e.g. a fix session that ran out of time). */
  private reviewNotes: string[] = [];

  constructor(options: TicketRunOptions = {}) {
    if (!isJiraConfigured()) {
      throw new Error('Jira is not configured. Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN.');
    }
    this.verbose = options.verbose ?? false;
    this.triageOnly = options.triageOnly ?? false;
    this.buildModel = options.buildModel;
    this.deep = options.deep ?? false;
    this.reviewRounds = options.reviewRounds ?? DEFAULT_REVIEW_ROUNDS;
    // Parse up front so a malformed --base-local fails before any session runs.
    this.baseLocal = options.baseLocal ? parseBaseLocalSpec(options.baseLocal) : undefined;
    this.noPush = options.noPush ?? false;
    this.jira = createJiraClient();
    this.spawner = createSpawner({ verbose: this.verbose });
    this.manifest = loadRepoManifest(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
    this.mcpConfig = options.mcpConfig ?? process.env.TURKEYCODE_MCP_CONFIG;

    if (!this.manifest) {
      console.warn(
        `[ticket] No repo manifest found at ${options.manifestPath ?? DEFAULT_MANIFEST_PATH}. ` +
          `Triage and non-coding research will still work, but coding tickets require a manifest.`,
      );
    }
  }

  async runTicket(ticketKey: string): Promise<void> {
    console.log(`\n[ticket] Starting run for ${ticketKey}`);
    audit('ticket_run_started', { details: { ticket: ticketKey } });

    const runStart = Date.now();
    const timings: PhaseTimings = {};

    try {
      const ticket = await this.jira.getTicket(ticketKey);
      if (!ticket) {
        throw new Error(`Could not fetch ticket ${ticketKey} from Jira`);
      }
      console.log(`[ticket] ${ticket.key}: ${ticket.summary}`);
      console.log(`[ticket] Type=${ticket.issueType} Status=${ticket.status} Attachments=${ticket.attachments.length}`);

      const ticketDir = this.prepareTicketDir(ticketKey);
      writeFileSync(join(ticketDir, 'ticket.json'), JSON.stringify(ticket, null, 2));

      const imagePaths = await this.downloadImageAttachments(ticket, ticketDir);
      if (imagePaths.length > 0) {
        console.log(`[ticket] Downloaded ${imagePaths.length} image attachment(s)`);
      }

      const triageStart = Date.now();
      const verdict = await this.runTriage(ticket, imagePaths, ticketDir);
      timings.triage = Date.now() - triageStart;
      console.log(`[ticket] Triage verdict: ${verdict.classification} (${verdict.confidence}) — ${verdict.reason}`);
      audit('ticket_triage', {
        details: {
          ticket: ticketKey,
          classification: verdict.classification,
          confidence: verdict.confidence,
        },
      });

      if (this.triageOnly) {
        console.log('');
        console.log(`[ticket] --triage-only: stopping after triage.`);
        console.log(`[ticket]   Classification: ${verdict.classification}`);
        console.log(`[ticket]   Confidence: ${verdict.confidence}`);
        console.log(`[ticket]   Reason: ${verdict.reason}`);
        if (verdict.repos.length > 0) {
          console.log(`[ticket]   Scoped repos:`);
          verdict.repos.forEach((r) => console.log(`[ticket]     - ${r}`));
        } else {
          console.log(`[ticket]   Scoped repos: (none)`);
        }
        console.log(`[ticket]   Verdict file: ${join(ticketDir, 'triage.json')}`);
        return;
      }

      if (verdict.classification === 'non-coding') {
        const researchStart = Date.now();
        await this.runNonCodingPath(ticket, imagePaths, ticketDir, verdict);
        timings.research = Date.now() - researchStart;
        return;
      }

      if (!this.manifest) {
        throw new Error(
          `Ticket ${ticketKey} was classified as coding, but no repo manifest is loaded. ` +
            `Create ~/.turkeycode/repos.yaml first.`,
        );
      }

      await this.runCodingPath(ticket, imagePaths, ticketDir, verdict, this.manifest, timings);
      audit('ticket_run_completed', { details: { ticket: ticketKey } });
    } finally {
      clearInFlight(TICKETS_ROOT, ticketKey);
      const totalMs = Date.now() - runStart;
      await this.logTicketTime(ticketKey, totalMs, timings);
    }
  }

  private async logTicketTime(ticketKey: string, totalMs: number, timings: PhaseTimings): Promise<void> {
    if (this.triageOnly) {
      console.log(`[ticket] (triage-only) Skipping Jira worklog. Wall clock: ${formatJiraDuration(totalMs)}`);
      return;
    }
    // Time tracked elsewhere (e.g. a billing timer that posts its own worklogs): report it, don't log it twice
    if (process.env.TURKEYCODE_NO_WORKLOG === '1') {
      console.log(`[ticket] TURKEYCODE_NO_WORKLOG=1: skipping Jira worklog. Wall clock: ${formatJiraDuration(totalMs)} (${totalMs} ms)`);
      return;
    }
    const totalStr = formatJiraDuration(totalMs);
    const breakdown: string[] = [`turkeycode automated run — ${totalStr} total`];
    const labels: Array<[keyof PhaseTimings, string]> = [
      ['triage', 'Triage'],
      ['research', 'Research'],
      ['plan', 'Plan'],
      ['build', 'Build'],
      ['review', 'Review'],
      ['fix', 'Review fixes'],
      ['merge_fix', 'Merge fix'],
      ['rebase_push', 'Rebase + push'],
    ];
    for (const [key, label] of labels) {
      const ms = timings[key];
      if (ms && ms > 0) breakdown.push(`- ${label}: ${formatJiraDuration(ms)}`);
    }
    const comment = breakdown.join('\n');
    const ok = await this.jira.logWork(ticketKey, totalStr, comment);
    if (!ok) {
      console.warn(`[ticket] Could not log worklog for ${ticketKey} (${totalStr}). Continuing.`);
    }
  }

  private prepareTicketDir(ticketKey: string): string {
    const dir = join(TICKETS_ROOT, ticketKey);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    return dir;
  }

  private async downloadImageAttachments(ticket: TicketDetail, ticketDir: string): Promise<string[]> {
    const paths: string[] = [];
    for (const att of ticket.attachments) {
      if (!att.mimeType.startsWith(IMAGE_MIME_PREFIX)) continue;
      const safeName = sanitizeFilename(att.filename) || `${att.id}${extensionFromMime(att.mimeType)}`;
      const destPath = join(ticketDir, 'attachments', `${att.id}-${safeName}`);
      const ok = await this.jira.downloadAttachment(att, destPath);
      if (!ok) {
        console.warn(`[ticket] Could not download attachment ${att.filename}`);
        continue;
      }
      const shrinkResult = await shrinkImageToFit(destPath);
      if (shrinkResult === null) {
        console.warn(
          `[ticket] Skipping attachment ${att.filename} — exceeds Claude's 5 MB per-image cap ` +
            `and could not be shrunk (install \`sharp\` or check the file).`,
        );
        continue;
      }
      if (shrinkResult.shrunk) {
        const beforeKb = (shrinkResult.originalBytes / 1024).toFixed(0);
        const afterKb = (shrinkResult.finalBytes / 1024).toFixed(0);
        console.log(
          `[ticket] Shrunk oversized attachment ${att.filename} ` +
            `(${beforeKb} KB → ${afterKb} KB as ${basename(shrinkResult.path)})`,
        );
      }
      paths.push(shrinkResult.path);
    }
    return paths;
  }

  private async runTriage(
    ticket: TicketDetail,
    imagePaths: string[],
    ticketDir: string,
  ): Promise<TriageVerdict> {
    const verdictPath = join(ticketDir, 'triage.json');
    const doneFile = join(ticketDir, 'triage.done');

    // Reset done file so a prior run doesn't short-circuit the new session
    if (existsSync(doneFile)) unlinkSafe(doneFile);

    const prompt = buildTicketTriagePrompt({
      ticket,
      manifest: this.manifest ?? emptyManifest(),
      imagePaths,
      verdictPath,
      doneFile,
    });

    const result = await this.spawner.run({
      cwd: ticketDir,
      prompt,
      timeoutMs: TRIAGE_TIMEOUT_MS,
      sessionName: `triage-${ticket.key}`,
      doneFile: 'triage.done',
      model: getModelForPhase('qa-smoke'),
      mcpConfig: this.mcpConfig,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Triage session failed for ${ticket.key} (exit ${result.exitCode})`);
    }
    if (!existsSync(verdictPath)) {
      throw new Error(`Triage session did not produce ${verdictPath}`);
    }

    const raw = readFileSync(verdictPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TriageVerdict>;
    if (parsed.classification !== 'coding' && parsed.classification !== 'non-coding') {
      throw new Error(`Triage verdict has invalid classification: ${parsed.classification}`);
    }
    const repos = Array.isArray(parsed.repos) ? parsed.repos.filter((r): r is string => typeof r === 'string') : [];
    return {
      classification: parsed.classification,
      confidence: parsed.confidence ?? 'medium',
      reason: parsed.reason ?? '',
      summary: parsed.summary ?? '',
      repos,
    };
  }

  private async runNonCodingPath(
    ticket: TicketDetail,
    imagePaths: string[],
    ticketDir: string,
    verdict: TriageVerdict,
  ): Promise<void> {
    const commentDraftPath = join(ticketDir, 'comment.md');
    const doneFile = join(ticketDir, 'research.done');

    if (existsSync(doneFile)) unlinkSafe(doneFile);

    const prompt = buildTicketResearchPrompt({
      ticket,
      manifest: this.manifest ?? emptyManifest(),
      imagePaths,
      commentDraftPath,
      doneFile,
      triageSummary: verdict.summary,
    });

    console.log(`[ticket] Running non-coding research session...`);
    const result = await this.spawner.run({
      cwd: ticketDir,
      prompt,
      timeoutMs: TICKET_RESEARCH_TIMEOUT_MS,
      sessionName: `research-${ticket.key}`,
      doneFile: 'research.done',
      model: getModelForPhase('research'),
      mcpConfig: this.mcpConfig,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Ticket research session failed for ${ticket.key} (exit ${result.exitCode})`);
    }
    if (!existsSync(commentDraftPath)) {
      throw new Error(`Ticket research did not produce ${commentDraftPath}`);
    }

    const draft = readFileSync(commentDraftPath, 'utf-8').trim();
    if (!draft) {
      throw new Error(`Ticket research produced an empty comment for ${ticket.key}`);
    }

    const header = `turkeycode (automated):\n\n`;
    const posted = await this.jira.addComment(ticket.key, header + draft);
    if (!posted) {
      console.error(`[ticket] Draft was written but the Jira comment post failed. Draft at: ${commentDraftPath}`);
      throw new Error(`Failed to post research comment to ${ticket.key}`);
    }
    console.log(`[ticket] Posted research comment to ${ticket.key}`);
    audit('ticket_research_posted', { details: { ticket: ticket.key } });
  }

  private async runCodingPath(
    ticket: TicketDetail,
    imagePaths: string[],
    ticketDir: string,
    verdict: TriageVerdict,
    manifest: RepoManifest,
    timings: PhaseTimings,
  ): Promise<void> {
    // Scope the run to just the repos triage flagged. Avoids cutting branches in
    // microservices that have nothing to do with this ticket.
    const scopedManifest = scopeManifestToTriage(manifest, verdict.repos, ticket.key);
    console.log(
      `[ticket] Triage scoped to ${scopedManifest.repos.length}/${manifest.repos.length} repo(s): ` +
        `${scopedManifest.repos.map((r) => r.path).join(', ')}`,
    );
    audit('ticket_scope_resolved', {
      details: {
        ticket: ticket.key,
        scoped: scopedManifest.repos.map((r) => r.path),
        total: manifest.repos.length,
      },
    });

    const branchName = renderBranchName(manifest.branchPattern, {
      key: ticket.key,
      slug: slugify(ticket.summary),
    });
    console.log(`[ticket] Coding path — branch name: ${branchName}`);

    // 0. --base-local: which scoped repos build on a local ref instead of origin/<base>
    let localBases = new Map<string, string>();
    if (this.baseLocal) {
      const resolved = resolveLocalBases(scopedManifest.repos, this.baseLocal);
      localBases = resolved.localBases;
      for (const [path, ref] of localBases) console.log(`[ticket] --base-local: ${path} builds on local ${ref}`);
      for (const path of resolved.fallback) {
        console.log(`[ticket] --base-local: ref not in ${path}; it keeps origin/<base>`);
      }
    }

    // 1. Preflight
    this.currentLocalBases = localBases;
    const preflight = preflightRepos(scopedManifest, { allowDirty: false, localBases });
    if (!preflight.ok) {
      const summary = preflight.issues.map((i) => `  - [${i.kind}] ${i.repo}: ${i.detail}`).join('\n');
      throw new Error(`Preflight failed:\n${summary}`);
    }

    // 2. Sync base + cut branch in scoped repos; record base SHAs for touched-repo detection
    const baseShas = new Map<string, string>();
    for (const repo of scopedManifest.repos) {
      const localRef = localBases.get(repo.path);
      if (localRef) {
        const sha = resolveLocalBase(repo, localRef);
        console.log(`[ticket] Using local base ${localRef} (${sha.slice(0, 10)}) in ${repo.path}`);
        baseShas.set(repo.path, sha);
        cutTicketBranch(repo, branchName, localRef);
        continue;
      }
      console.log(`[ticket] Syncing ${repo.path} (base=${repo.base})`);
      const sha = syncBase(repo);
      baseShas.set(repo.path, sha);
      cutTicketBranch(repo, branchName);
    }

    // 2b. Announce this run to other run-ticket processes on the machine, and see who else is in these repos.
    const repoPaths = scopedManifest.repos.map((r) => r.path);
    markInFlight(TICKETS_ROOT, { key: ticket.key, summary: ticket.summary, branch: branchName, repos: repoPaths });
    const neighbours = (): InFlightNeighbour[] => {
      const others = listInFlight(TICKETS_ROOT, ticket.key, repoPaths);
      if (others.length > 0) console.log(`[ticket] Also being built in these repos: ${others.map((o) => o.key).join(', ')}`);
      return others;
    };

    // 3a. Deep tier: plan session (research only) the build follows
    let planPath: string | undefined;
    if (this.deep) {
      const planStart = Date.now();
      planPath = await this.runPlan(ticket, imagePaths, ticketDir, verdict, scopedManifest, neighbours());
      timings.plan = Date.now() - planStart;
    }

    // 3. Run the build session (one session, sees all scoped repos)
    const buildDoneFile = join(ticketDir, 'build.done');
    if (existsSync(buildDoneFile)) unlinkSafe(buildDoneFile);

    const buildPrompt = buildTicketBuildPrompt({
      ticket,
      manifest: scopedManifest,
      branchName,
      imagePaths,
      triageSummary: verdict.summary,
      doneFile: buildDoneFile,
      planPath,
      localBases: Object.fromEntries(this.currentLocalBases),
      // Asked again here, not reused from the plan step: a neighbour that had no plan then has one now.
      inFlight: neighbours(),
    });

    const buildModel = this.buildModel ?? getModelForPhase('build');
    console.log(`[ticket] Running build session (${buildModel ?? 'default model'})...`);
    const buildCwd = scopedManifest.repos[0].path;
    const buildStart = Date.now();
    const buildResult = await this.spawner.run({
      cwd: buildCwd,
      prompt: buildPrompt,
      timeoutMs: PHASE_BUILD_TIMEOUT_MS,
      sessionName: `build-${ticket.key}`,
      doneFile: buildDoneFile,
      model: buildModel,
      mcpConfig: this.mcpConfig,
    });
    timings.build = Date.now() - buildStart;

    if (buildResult.exitCode !== 0) {
      throw new Error(`Build session failed for ${ticket.key} (exit ${buildResult.exitCode})`);
    }

    // 4. Detect touched repos — repos with commits beyond their base SHA
    const touched: RepoEntry[] = [];
    for (const repo of scopedManifest.repos) {
      const baseSha = baseShas.get(repo.path)!;
      if (repoHasCommits(repo, branchName, baseSha)) {
        touched.push(repo);
      }
    }

    if (touched.length === 0) {
      console.warn(`[ticket] Build session completed but no repo has commits on ${branchName}.`);
      await this.jira.addComment(
        ticket.key,
        `turkeycode ran a build session but produced no commits across any repo. Triage rationale: ${verdict.reason}`,
      );
      return;
    }
    console.log(`[ticket] Touched repos: ${touched.map((r) => r.path).join(', ')}`);

    let mergeFixMs = 0;
    let rebasePushMs = 0;

    // 4b. Deep tier: review → fix rounds before anything leaves the machine
    let openFindings: ReviewFinding[] = [];
    if (this.deep) {
      // Rebase first, so the reviewer reads the code as it will merge and a conflict with other in-flight
      // work is resolved while there are still review rounds left to check the resolution.
      const early = await this.rebaseBeforeReview(ticket, touched, branchName, ticketDir, verdict, localBases, baseShas, planPath);
      mergeFixMs += early.mergeFixMs;
      rebasePushMs += early.totalMs;
      openFindings = await this.runReviewRounds(ticket, ticketDir, scopedManifest, touched, baseShas, branchName, planPath, timings);
      // A fix session may have committed in a scoped repo the build left alone
      for (const repo of scopedManifest.repos) {
        if (!touched.includes(repo) && repoHasCommits(repo, branchName, baseShas.get(repo.path)!)) {
          touched.push(repo);
        }
      }
    }

    // 5. Rebase + push each touched repo, invoking merge-fix on conflict
    //    (--no-push: rebase only; --base-local: rebase onto the local ref, no fetch)
    const pushed: { repo: RepoEntry; remoteUrl?: string }[] = [];
    const local: { repo: RepoEntry; sha: string }[] = [];
    const failed: { repo: RepoEntry; reason: string }[] = [];

    for (const repo of touched) {
      const repoStart = Date.now();
      const step = planFinalizeStep(repo, { localRef: localBases.get(repo.path), noPush: this.noPush });
      console.log(`[ticket] Rebasing ${repo.path} onto ${step.rebaseOnto}...`);
      const rebase = await this.rebaseWithMergeFix(ticket, repo, branchName, ticketDir, verdict, step.localRef, planPath);
      mergeFixMs += rebase.mergeFixMs;

      if (!rebase.ok) {
        rebasePushMs += Date.now() - repoStart;
        failed.push({ repo, reason: rebase.reason });
        continue;
      }

      if (!step.push) {
        local.push({ repo, sha: headSha(repo.path) });
        audit('ticket_branch_local', { details: { ticket: ticket.key, repo: repo.path, branch: branchName } });
        rebasePushMs += Date.now() - repoStart;
        continue;
      }

      console.log(`[ticket] Pushing ${repo.path}...`);
      const push = pushBranch(repo, branchName);
      if (push.status === 'pushed') {
        pushed.push({ repo, remoteUrl: push.remoteUrl });
        audit('ticket_branch_pushed', { details: { ticket: ticket.key, repo: repo.path, branch: branchName } });
      } else {
        failed.push({ repo, reason: push.detail ?? 'push failed' });
      }
      rebasePushMs += Date.now() - repoStart;
    }

    // Subtract merge-fix from rebase_push so the two don't overlap in the worklog comment.
    timings.merge_fix = mergeFixMs;
    timings.rebase_push = Math.max(0, rebasePushMs - mergeFixMs);

    // 6. Post outcome to Jira
    const tier = this.deep ? `deep tier: plan → build (${buildModel ?? 'default model'}) → review/fix` : `build (${buildModel ?? 'default model'})`;
    const commentLines: string[] = [`turkeycode built ${ticket.key} on branch \`${branchName}\` (${tier}).`, ''];
    if (pushed.length > 0) {
      commentLines.push('Pushed branches:');
      for (const p of pushed) {
        commentLines.push(`- ${p.repo.path}${p.remoteUrl ? ` — ${p.remoteUrl}` : ''}`);
      }
    }
    if (local.length > 0) {
      commentLines.push('Local branches (--no-push; not on the remote yet):');
      for (const l of local) {
        commentLines.push(`- ${l.repo.path} @ ${l.sha.slice(0, 12)}`);
      }
    }
    if (this.deep) {
      if (openFindings.length === 0) {
        commentLines.push('', 'Automated review: clean.');
      } else {
        commentLines.push('', `Automated review: ${openFindings.length} finding(s) still open after ${this.reviewRounds} round(s):`);
        for (const f of openFindings) {
          commentLines.push(`- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}${f.summary}`);
        }
      }
    }
    if (this.deep && this.reviewNotes.length > 0) {
      commentLines.push('', ...this.reviewNotes.map((n) => `Note: ${n}`));
    }
    if (failed.length > 0) {
      commentLines.push('', 'Failed repos (manual intervention needed):');
      for (const f of failed) {
        commentLines.push(`- ${f.repo.path}: ${f.reason}`);
      }
    }
    await this.jira.addComment(ticket.key, commentLines.join('\n'));

    if (local.length > 0) {
      // Machine-readable hand-off for whoever folds the local branch into their stack.
      writeFileSync(
        join(ticketDir, 'local-branches.json'),
        JSON.stringify({ branch: branchName, repos: local.map((l) => ({ path: l.repo.path, sha: l.sha })) }, null, 2),
      );
      console.log('');
      console.log(`[ticket] --no-push: branch ${branchName} left local:`);
      for (const l of local) console.log(`[ticket]   ${l.repo.path}  ${branchName}  ${l.sha}`);
    }

    if (failed.length > 0) {
      throw new Error(
        `Ticket ${ticket.key}: ${pushed.length} repo(s) pushed, ${local.length} kept local, ${failed.length} failed. See Jira comment for details.`,
      );
    }

    // --no-push: nothing is on the remote, so a "ready for review" transition would be a lie.
    if (this.noPush) {
      console.log(`[ticket] --no-push: skipping Jira transition to "${manifest.transitionAfterPush}".`);
      return;
    }

    // 7. Transition the ticket to the manifest-configured target status.
    //    transitionTicket logs and moves on if the status name doesn't match the project's workflow.
    await this.jira.transitionTicket(ticket.key, manifest.transitionAfterPush);
  }

  private async runPlan(
    ticket: TicketDetail,
    imagePaths: string[],
    ticketDir: string,
    verdict: TriageVerdict,
    manifest: RepoManifest,
    inFlight: InFlightNeighbour[] = [],
  ): Promise<string> {
    const planPath = join(ticketDir, 'plan.md');
    const doneFile = join(ticketDir, 'plan.done');
    if (existsSync(doneFile)) unlinkSafe(doneFile);
    console.log(`[ticket] Running plan session...`);
    const result = await this.spawner.run({
      cwd: manifest.repos[0].path,
      prompt: buildTicketPlanPrompt({
        ticket,
        manifest,
        imagePaths,
        triageSummary: verdict.summary,
        planPath,
        doneFile,
        localBases: Object.fromEntries(this.currentLocalBases),
        inFlight,
      }),
      timeoutMs: TICKET_PLAN_TIMEOUT_MS,
      sessionName: `plan-${ticket.key}`,
      doneFile,
      model: getModelForPhase('plan'),
      mcpConfig: this.mcpConfig,
    });
    if (result.exitCode !== 0 || !existsSync(planPath)) {
      throw new Error(`Plan session failed for ${ticket.key} (exit ${result.exitCode})`);
    }
    return planPath;
  }

  /**
   * Review the ticket branches and fix what the reviewer finds, up to
   * reviewRounds times. Returns the findings still open after the last round.
   *
   * Rounds use different lenses (see reviewLens), so a clean round does NOT end
   * the loop early: the next round looks at the change from another angle. A fix
   * session only runs after a round that found something, and never after the
   * last round (its findings are reported as still open).
   */
  private async runReviewRounds(
    ticket: TicketDetail,
    ticketDir: string,
    manifest: RepoManifest,
    touched: RepoEntry[],
    baseShas: Map<string, string>,
    branchName: string,
    planPath: string | undefined,
    timings: PhaseTimings,
  ): Promise<ReviewFinding[]> {
    let findings: ReviewFinding[] = [];
    // Findings a reviewer marked needs-human: real, but not something a fix session can settle.
    // They never go to a fix session and never extend the loop; they are reported as open at the end.
    const needsHuman: ReviewFinding[] = [];
    let priorFindingsPath: string | undefined;
    let priorFixReportPath: string | undefined;
    let priorFixIncomplete = false;
    this.reviewNotes = [];
    timings.review = 0;
    timings.fix = 0;

    // The last scheduled round may still find something (often a problem in the previous round's fix). Rather than
    // leaving it open, run ONE extra fix → verify round; findings left after that are reported as open.
    let lastRound = this.reviewRounds;
    for (let round = 1; round <= lastRound; round++) {
      const findingsPath = join(ticketDir, `review-${round}.json`);
      const reviewDone = join(ticketDir, `review-${round}.done`);

      // "Not reviewed" handling (nothing cited survived): re-run the round ONCE
      // with a pointed reminder, then fail the run the same way a crashed review
      // session does (throw before anything is pushed). This is the least
      // invasive option: it reuses the existing failure path, never silently
      // reports "clean", and costs at most one extra session per round.
      let result: ReviewResult | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (existsSync(reviewDone)) unlinkSafe(reviewDone);
        if (existsSync(findingsPath)) unlinkSafe(findingsPath);
        console.log(`[ticket] Review round ${round}/${lastRound}${attempt > 1 ? ' (retry: nothing cited)' : ''}...`);
        const reviewStart = Date.now();
        const review = await this.spawner.run({
          cwd: touched[0].path,
          prompt: buildTicketReviewPrompt({
            ticket,
            manifest,
            repos: touched.map((r) => ({ path: r.path, baseSha: baseShas.get(r.path)!, localBase: this.currentLocalBases.get(r.path) })),
            branchName,
            planPath,
            priorFindingsPath,
            priorFixReportPath,
            priorFixIncomplete,
            findingsPath,
            doneFile: reviewDone,
            round,
            totalRounds: lastRound,
            uncitedRetry: attempt > 1,
          }),
          timeoutMs: TICKET_REVIEW_TIMEOUT_MS,
          sessionName: `review-${round}${attempt > 1 ? `-retry` : ''}-${ticket.key}`,
          doneFile: reviewDone,
          model: getModelForPhase('ticket-review'),
          mcpConfig: this.mcpConfig,
        });
        timings.review += Date.now() - reviewStart;
        if (review.exitCode !== 0 || !existsSync(findingsPath) || !readFileSync(findingsPath, 'utf-8').trim()) {
          throw new Error(`Review session failed for ${ticket.key} (round ${round}, exit ${review.exitCode})`);
        }

        result = parseReviewResult(readFileSync(findingsPath, 'utf-8'));
        if (result.droppedFindings > 0 || result.droppedVerified > 0) {
          console.warn(
            `[ticket] Review round ${round}: dropped ${result.droppedFindings} uncited finding(s) and ` +
              `${result.droppedVerified} uncited verified claim(s)`,
          );
        }
        if (result.reviewed) break;
        console.warn(`[ticket] Review round ${round}: no cited findings or verified claims — not reviewed`);
      }
      if (!result || !result.reviewed) {
        throw new Error(
          `Review round ${round} for ${ticket.key} produced nothing cited twice — treating the branch as not reviewed. ` +
            `Branches are left local and unpushed; see ${findingsPath}.`,
        );
      }

      const forPerson = result.findings.filter(isNeedsHuman);
      findings = result.findings.filter((f) => !isNeedsHuman(f));
      for (const f of forPerson) {
        if (!needsHuman.some((known) => sameFinding(known, f))) needsHuman.push(f);
      }
      console.log(
        `[ticket] Review round ${round}: ${findings.length} finding(s)` +
          `${forPerson.length ? `, ${forPerson.length} for a person` : ''}, ${result.verified.length} verified claim(s)`,
      );
      if (round === lastRound) {
        // Only for multi-round runs: --review-rounds 1 means exactly one review.
        if (findings.length === 0 || lastRound > this.reviewRounds || this.reviewRounds < 2) break;
        lastRound++;
        console.log(`[ticket] Last scheduled round found ${findings.length} finding(s): one extra fix → verify round (${lastRound}).`);
      }
      if (findings.length === 0) continue; // next round, next lens; nothing to fix

      const fixDone = join(ticketDir, `fix-${round}.done`);
      if (existsSync(fixDone)) unlinkSafe(fixDone);
      console.log(`[ticket] Fixing round ${round} findings...`);
      const fixStart = Date.now();
      const fix = await this.spawner.run({
        cwd: touched[0].path,
        prompt: buildTicketFixPrompt({ ticket, manifest, branchName, findingsPath, planPath, doneFile: fixDone, localBases: Object.fromEntries(this.currentLocalBases) }),
        timeoutMs: FIX_TIMEOUT_MS,
        sessionName: `fix-${round}-${ticket.key}`,
        doneFile: fixDone,
        model: getModelForPhase('qa-fix'),
        mcpConfig: this.mcpConfig,
      });
      timings.fix += Date.now() - fixStart;
      priorFixIncomplete = fix.exitCode !== 0;
      if (priorFixIncomplete) {
        // A fix session that runs out of time (or dies) does not sink the ticket: the build and the earlier
        // rounds are still good. Whatever it committed stays on the branch, whatever it left uncommitted is
        // stashed (kept, but out of the way of the rebase), and the next review round, which always follows
        // a fix, re-checks every finding against the code as it now stands.
        const why = fix.exitCode === 124 ? 'ran out of time' : `failed (exit ${fix.exitCode})`;
        const label = `turkeycode ${ticket.key} fix-${round} unfinished`;
        const stashed = manifest.repos.filter((r) => stashUncommitted(r.path, label)).map((r) => r.path);
        console.warn(`[ticket] Fix session for round ${round} ${why}; the next review round re-checks its findings.`);
        this.reviewNotes.push(
          `The fix session for review round ${round} ${why}. Its commits were kept and re-reviewed` +
            (stashed.length ? `; uncommitted work was stashed as "${label}" in ${stashed.join(', ')}.` : '.'),
        );
      }
      priorFindingsPath = findingsPath;
      priorFixReportPath = existsSync(fixDone) ? fixDone : undefined;
    }
    return [...findings, ...needsHuman.filter((h) => !findings.some((f) => sameFinding(f, h)))];
  }

  /**
   * Deep tier, before the first review round: rebase every touched repo onto its
   * base as it is NOW. Other tickets land while this one is being built, and a
   * conflict found only after the last review round is resolved by a session
   * nobody reviews, or not at all. Done here, the reviewer sees the integrated
   * code and the resolution gets the same scrutiny as the rest of the change.
   *
   * On success the repo's review base moves to the new base tip, so the review
   * diff stays "this ticket's change" and does not pick up what landed meanwhile.
   * A conflict that cannot be resolved here does not fail the ticket: the branch
   * is restored, reviewed as built, and the final rebase gets another attempt.
   */
  private async rebaseBeforeReview(
    ticket: TicketDetail,
    touched: RepoEntry[],
    branchName: string,
    ticketDir: string,
    verdict: TriageVerdict,
    localBases: Map<string, string>,
    baseShas: Map<string, string>,
    planPath: string | undefined,
  ): Promise<{ mergeFixMs: number; totalMs: number }> {
    const start = Date.now();
    let mergeFixMs = 0;
    for (const repo of touched) {
      const localRef = localBases.get(repo.path);
      const onto = localRef ?? `origin/${repo.base}`;
      console.log(`[ticket] Rebasing ${repo.path} onto ${onto} before review...`);
      const rebase = await this.rebaseWithMergeFix(ticket, repo, branchName, ticketDir, verdict, localRef, planPath);
      mergeFixMs += rebase.mergeFixMs;
      if (rebase.ok) {
        baseShas.set(repo.path, resolveLocalBase(repo, onto));
      } else {
        console.warn(
          `[ticket] Could not rebase ${repo.path} before review (${rebase.reason}). ` +
            `Reviewing the branch as built; the final rebase will try again.`,
        );
      }
    }
    return { mergeFixMs, totalMs: Date.now() - start };
  }

  /**
   * Rebase the current branch of `repo` onto its base, handing each round of
   * conflicts to a merge-fix session. Never leaves a rebase in progress: on any
   * failure the branch is put back where it was.
   */
  private async rebaseWithMergeFix(
    ticket: TicketDetail,
    repo: RepoEntry,
    branchName: string,
    ticketDir: string,
    verdict: TriageVerdict,
    localRef: string | undefined,
    planPath: string | undefined,
  ): Promise<{ ok: true; mergeFixMs: number } | { ok: false; reason: string; mergeFixMs: number }> {
    let mergeFixMs = 0;
    let rebase = rebaseOntoBase(repo, localRef);
    while (rebase.status === 'conflict') {
      console.log(`[ticket] Conflict(s) in ${repo.path}: ${rebase.conflictedPaths?.join(', ')}`);
      const mergeFixStart = Date.now();
      const resolved = await this.runMergeFix(
        ticket, repo, branchName, rebase.conflictedPaths ?? [], ticketDir, verdict, localRef, planPath,
      );
      mergeFixMs += Date.now() - mergeFixStart;
      if (!resolved) {
        abortRebase(repo.path);
        return { ok: false, reason: 'rebase conflict could not be resolved', mergeFixMs };
      }
      // Merge-fix session may have already run `git rebase --continue`; verify rebase state
      rebase = continueRebase(repo.path);
    }
    if (rebase.status === 'error') {
      abortRebase(repo.path);
      return { ok: false, reason: rebase.detail ?? 'rebase error', mergeFixMs };
    }
    return { ok: true, mergeFixMs };
  }

  private async runMergeFix(
    ticket: TicketDetail,
    repo: RepoEntry,
    branchName: string,
    conflictedPaths: string[],
    ticketDir: string,
    verdict: TriageVerdict,
    rebaseOnto?: string,
    planPath?: string,
  ): Promise<boolean> {
    const doneFile = join(ticketDir, `merge-fix-${sanitizeFilename(repo.path)}.done`);
    if (existsSync(doneFile)) unlinkSafe(doneFile);

    const prompt = buildMergeFixPrompt({
      repoPath: repo.path,
      branchName,
      baseBranch: repo.base,
      rebaseOnto,
      conflictedPaths,
      mode: 'rebase',
      contextKey: ticket.key,
      contextSummary: verdict.summary || ticket.summary,
      planPath,
      ticketsRoot: TICKETS_ROOT,
      doneFile,
    });

    const result = await this.spawner.run({
      cwd: repo.path,
      prompt,
      timeoutMs: FIX_TIMEOUT_MS,
      sessionName: `merge-fix-${ticket.key}`,
      doneFile,
      model: getModelForPhase('qa-fix'),
      mcpConfig: this.mcpConfig,
    });

    if (result.exitCode !== 0 || !existsSync(doneFile)) {
      return false;
    }

    const doneContent = readFileSync(doneFile, 'utf-8').trim();
    if (doneContent.startsWith('ABORTED')) {
      console.warn(`[ticket] Merge-fix aborted for ${repo.path}: ${doneContent}`);
      return false;
    }
    return true;
  }
}

function emptyManifest(): RepoManifest {
  return {
    defaultBase: 'develop',
    branchPattern: 'ticket/{key}',
    repos: [],
    references: [],
    transitionAfterPush: 'In Review',
  };
}

/**
 * Reduce the manifest to just the repos triage flagged. Throws if the triage
 * output is empty or names paths not present in the manifest — we'd rather
 * stop the run than silently fall back to "branch every repo".
 */
export function scopeManifestToTriage(
  manifest: RepoManifest,
  triageRepos: string[],
  ticketKey: string,
): RepoManifest {
  if (triageRepos.length === 0) {
    throw new Error(
      `Ticket ${ticketKey}: triage classified this as coding but did not name any repos. ` +
        `Refusing to run a build across all ${manifest.repos.length} manifest repos. ` +
        `Re-run after the triage prompt produces a non-empty 'repos' list, or update the ticket so the target repo is unambiguous.`,
    );
  }

  const manifestPaths = new Set(manifest.repos.map((r) => r.path));
  const unknown = triageRepos.filter((p) => !manifestPaths.has(p));
  if (unknown.length > 0) {
    throw new Error(
      `Ticket ${ticketKey}: triage named repos that are not in the manifest: ${unknown.join(', ')}. ` +
        `Manifest paths: ${[...manifestPaths].join(', ')}.`,
    );
  }

  const wanted = new Set(triageRepos);
  const scoped = manifest.repos.filter((r) => wanted.has(r.path));
  return { ...manifest, repos: scoped };
}

/** Parse a review session's findings file. Throws on anything but `{ findings: [...] }`. */
export function parseReviewFindings(raw: string): ReviewFinding[] {
  const parsed = JSON.parse(raw) as { findings?: unknown };
  if (!Array.isArray(parsed.findings)) {
    throw new Error('Review findings file has no findings array');
  }
  return parsed.findings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      severity: typeof f.severity === 'string' ? f.severity : 'should-fix',
      repo: typeof f.repo === 'string' ? f.repo : undefined,
      file: typeof f.file === 'string' ? f.file : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
      summary: typeof f.summary === 'string' ? f.summary : JSON.stringify(f),
      fix: typeof f.fix === 'string' ? f.fix : undefined,
      evidence: Array.isArray(f.evidence) ? citations(f.evidence) : undefined,
    }));
}

/** `path:line` or `path:start-end` (path non-empty; trailing context after whitespace is tolerated). */
const CITATION = /^\S.*:\d+(?:\s*[-–]\s*\d+)?(?:\s.*)?$/;

export function isCitation(value: unknown): value is string {
  return typeof value === 'string' && CITATION.test(value.trim());
}

function citations(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter(isCitation).map((c) => c.trim()) : [];
}

/**
 * Parse a review findings file and enforce the evidence rule: findings and
 * verified claims without at least one `file:line` citation are dropped (and
 * counted). `reviewed` is false when nothing cited survived — zero findings
 * AND zero verified claims means the reviewer showed no work, which must not
 * be mistaken for a clean branch.
 */
/** A finding the reviewer routed to a person instead of a fix session. */
export function isNeedsHuman(finding: ReviewFinding): boolean {
  return finding.severity === 'needs-human';
}

/** Same finding reported in two rounds: same place when both give one, otherwise the same summary. */
function sameFinding(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.file && b.file && a.line !== undefined && b.line !== undefined) {
    return a.file === b.file && a.line === b.line && (a.repo ?? '') === (b.repo ?? '');
  }
  return a.summary === b.summary;
}

export function parseReviewResult(raw: string): ReviewResult {
  const all = parseReviewFindings(raw);
  const findings = all.filter((f) => (f.evidence?.length ?? 0) > 0);
  const parsed = JSON.parse(raw) as { verified?: unknown };
  const rawVerified = Array.isArray(parsed.verified) ? parsed.verified : [];
  const verified: VerifiedClaim[] = [];
  let droppedVerified = 0;
  for (const v of rawVerified) {
    const rec = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
    const evidence = citations(rec?.evidence);
    if (!rec || typeof rec.claim !== 'string' || !rec.claim.trim() || evidence.length === 0) {
      droppedVerified++;
      continue;
    }
    verified.push({ claim: rec.claim, evidence });
  }
  return {
    findings,
    verified,
    droppedFindings: all.length - findings.length,
    droppedVerified,
    reviewed: findings.length > 0 || verified.length > 0,
  };
}

export interface FinalizeStep {
  /** Human-readable rebase target (local ref or origin/<base>). */
  rebaseOnto: string;
  /** Set under --base-local: rebase onto this local ref without fetching. */
  localRef?: string;
  /** False under --no-push: leave the branch local after the rebase. */
  push: boolean;
}

/**
 * What the post-review step does for one touched repo. --base-local swaps the
 * rebase target (no fetch); --no-push keeps the rebase (so the branch sits on
 * top of its base, ready to fold in) but skips the push, the "pushed" audit and
 * the Jira transition. Billing/worklog is unaffected.
 */
export function planFinalizeStep(repo: RepoEntry, opts: { localRef?: string; noPush: boolean }): FinalizeStep {
  return {
    rebaseOnto: opts.localRef ?? `origin/${repo.base}`,
    localRef: opts.localRef,
    push: !opts.noPush,
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mime] ?? '';
}

function unlinkSafe(path: string): void {
  try {
    writeFileSync(path, ''); // truncate rather than delete to keep permissions; ignore failure
  } catch {
    /* ignore */
  }
}

export function createTicketOrchestrator(options?: TicketRunOptions): TicketOrchestrator {
  return new TicketOrchestrator(options);
}
