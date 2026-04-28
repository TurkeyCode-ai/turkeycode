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
import { join } from 'path';
import { createJiraClient, JiraClient, TicketDetail, isJiraConfigured } from './jira';
import { createSpawner, Spawner } from './spawner';
import {
  loadRepoManifest,
  preflightRepos,
  syncBase,
  cutTicketBranch,
  repoHasCommits,
  rebaseOntoBase,
  continueRebase,
  abortRebase,
  pushBranch,
  renderBranchName,
  RepoEntry,
  RepoManifest,
  DEFAULT_MANIFEST_PATH,
} from './repos';
import { buildTicketTriagePrompt } from './prompts/ticket-triage';
import { buildTicketResearchPrompt } from './prompts/ticket-research';
import { buildTicketBuildPrompt } from './prompts/ticket-build';
import { buildMergeFixPrompt } from './prompts/merge-fix';
import { getModelForPhase, PHASE_BUILD_TIMEOUT_MS, FIX_TIMEOUT_MS } from './constants';
import { audit } from './audit';

const TICKETS_ROOT = join(homedir(), '.turkeycode', 'tickets');

const TRIAGE_TIMEOUT_MS = 5 * 60 * 1000;
const TICKET_RESEARCH_TIMEOUT_MS = 20 * 60 * 1000;

export interface TicketRunOptions {
  verbose?: boolean;
  /** Override manifest path (defaults to ~/.turkeycode/repos.yaml). */
  manifestPath?: string;
  /** Override MCP config path (else uses TURKEYCODE_MCP_CONFIG). */
  mcpConfig?: string;
  /** Skip the preflight dirty-tree check across repos. */
  allowDirty?: boolean;
}

export interface TriageVerdict {
  classification: 'coding' | 'non-coding';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  summary: string;
}

const IMAGE_MIME_PREFIX = 'image/';

export class TicketOrchestrator {
  private jira: JiraClient;
  private spawner: Spawner;
  private manifest: RepoManifest | null;
  private mcpConfig: string | undefined;
  private verbose: boolean;

  constructor(options: TicketRunOptions = {}) {
    if (!isJiraConfigured()) {
      throw new Error('Jira is not configured. Set JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN.');
    }
    this.verbose = options.verbose ?? false;
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

    const verdict = await this.runTriage(ticket, imagePaths, ticketDir);
    console.log(`[ticket] Triage verdict: ${verdict.classification} (${verdict.confidence}) — ${verdict.reason}`);
    audit('ticket_triage', {
      details: {
        ticket: ticketKey,
        classification: verdict.classification,
        confidence: verdict.confidence,
      },
    });

    if (verdict.classification === 'non-coding') {
      await this.runNonCodingPath(ticket, imagePaths, ticketDir, verdict);
      return;
    }

    if (!this.manifest) {
      throw new Error(
        `Ticket ${ticketKey} was classified as coding, but no repo manifest is loaded. ` +
          `Create ~/.turkeycode/repos.yaml first.`,
      );
    }

    await this.runCodingPath(ticket, imagePaths, ticketDir, verdict, this.manifest);
    audit('ticket_run_completed', { details: { ticket: ticketKey } });
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
      if (ok) paths.push(destPath);
      else console.warn(`[ticket] Could not download attachment ${att.filename}`);
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
      model: getModelForPhase('qa-smoke') ?? 'haiku',
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
    return {
      classification: parsed.classification,
      confidence: parsed.confidence ?? 'medium',
      reason: parsed.reason ?? '',
      summary: parsed.summary ?? '',
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
      model: getModelForPhase('research') ?? 'sonnet',
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
  ): Promise<void> {
    const branchName = renderBranchName(manifest.branchPattern, { key: ticket.key });
    console.log(`[ticket] Coding path — branch name: ${branchName}`);

    // 1. Preflight
    const preflight = preflightRepos(manifest, { allowDirty: false });
    if (!preflight.ok) {
      const summary = preflight.issues.map((i) => `  - [${i.kind}] ${i.repo}: ${i.detail}`).join('\n');
      throw new Error(`Preflight failed:\n${summary}`);
    }

    // 2. Sync base + cut branch in every repo; record base SHAs for touched-repo detection
    const baseShas = new Map<string, string>();
    for (const repo of manifest.repos) {
      console.log(`[ticket] Syncing ${repo.path} (base=${repo.base})`);
      const sha = syncBase(repo);
      baseShas.set(repo.path, sha);
      cutTicketBranch(repo, branchName);
    }

    // 3. Run the build session (one session, sees all repos)
    const buildDoneFile = join(ticketDir, 'build.done');
    if (existsSync(buildDoneFile)) unlinkSafe(buildDoneFile);

    const buildPrompt = buildTicketBuildPrompt({
      ticket,
      manifest,
      branchName,
      imagePaths,
      triageSummary: verdict.summary,
      doneFile: buildDoneFile,
    });

    console.log(`[ticket] Running build session...`);
    const buildCwd = manifest.repos[0].path;
    const buildResult = await this.spawner.run({
      cwd: buildCwd,
      prompt: buildPrompt,
      timeoutMs: PHASE_BUILD_TIMEOUT_MS,
      sessionName: `build-${ticket.key}`,
      doneFile: buildDoneFile,
      model: getModelForPhase('build') ?? 'sonnet',
      mcpConfig: this.mcpConfig,
    });

    if (buildResult.exitCode !== 0) {
      throw new Error(`Build session failed for ${ticket.key} (exit ${buildResult.exitCode})`);
    }

    // 4. Detect touched repos — repos with commits beyond their base SHA
    const touched: RepoEntry[] = [];
    for (const repo of manifest.repos) {
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

    // 5. Rebase + push each touched repo, invoking merge-fix on conflict
    const pushed: { repo: RepoEntry; remoteUrl?: string }[] = [];
    const failed: { repo: RepoEntry; reason: string }[] = [];

    for (const repo of touched) {
      console.log(`[ticket] Rebasing ${repo.path} onto origin/${repo.base}...`);
      let rebase = rebaseOntoBase(repo);

      while (rebase.status === 'conflict') {
        console.log(`[ticket] Conflict(s) in ${repo.path}: ${rebase.conflictedPaths?.join(', ')}`);
        const resolved = await this.runMergeFix(ticket, repo, branchName, rebase.conflictedPaths ?? [], ticketDir, verdict);
        if (!resolved) {
          abortRebase(repo.path);
          failed.push({ repo, reason: 'rebase conflict could not be resolved' });
          rebase = { status: 'error', detail: 'aborted by merge-fix' };
          break;
        }
        // Merge-fix session may have already run `git rebase --continue`; verify rebase state
        rebase = continueRebase(repo.path);
      }

      if (rebase.status === 'error') {
        if (!failed.find((f) => f.repo.path === repo.path)) {
          failed.push({ repo, reason: rebase.detail ?? 'rebase error' });
        }
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
    }

    // 6. Post outcome to Jira
    const commentLines: string[] = [`turkeycode built ${ticket.key} on branch \`${branchName}\`.`, ''];
    if (pushed.length > 0) {
      commentLines.push('Pushed branches:');
      for (const p of pushed) {
        commentLines.push(`- ${p.repo.path}${p.remoteUrl ? ` — ${p.remoteUrl}` : ''}`);
      }
    }
    if (failed.length > 0) {
      commentLines.push('', 'Failed repos (manual intervention needed):');
      for (const f of failed) {
        commentLines.push(`- ${f.repo.path}: ${f.reason}`);
      }
    }
    await this.jira.addComment(ticket.key, commentLines.join('\n'));

    if (failed.length > 0) {
      throw new Error(
        `Ticket ${ticket.key}: ${pushed.length} repo(s) pushed, ${failed.length} failed. See Jira comment for details.`,
      );
    }

    // 7. Transition the ticket. 'In Review' is common; if the project uses a different name, this logs and moves on.
    await this.jira.transitionTicket(ticket.key, 'In Review');
  }

  private async runMergeFix(
    ticket: TicketDetail,
    repo: RepoEntry,
    branchName: string,
    conflictedPaths: string[],
    ticketDir: string,
    verdict: TriageVerdict,
  ): Promise<boolean> {
    const doneFile = join(ticketDir, `merge-fix-${sanitizeFilename(repo.path)}.done`);
    if (existsSync(doneFile)) unlinkSafe(doneFile);

    const prompt = buildMergeFixPrompt({
      repoPath: repo.path,
      branchName,
      baseBranch: repo.base,
      conflictedPaths,
      ticketKey: ticket.key,
      ticketSummary: verdict.summary || ticket.summary,
      doneFile,
    });

    const result = await this.spawner.run({
      cwd: repo.path,
      prompt,
      timeoutMs: FIX_TIMEOUT_MS,
      sessionName: `merge-fix-${ticket.key}`,
      doneFile,
      model: getModelForPhase('qa-fix') ?? 'sonnet',
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
  return { defaultBase: 'develop', branchPattern: 'ticket/{key}', repos: [] };
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
