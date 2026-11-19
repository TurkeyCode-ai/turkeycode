/**
 * Multi-repo manifest loader + git preflight.
 * Reads ~/.turkeycode/repos.yaml and prepares each repo for a phase build.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'child_process';

export interface RepoEntry {
  path: string;
  role?: string;
  base: string;
  start?: string;
  healthcheck?: string;
}

/**
 * Read-only reference path. May or may not be a git repo — turkeycode never
 * runs git operations against it. Only purpose: build sessions can `Read`/`Grep`
 * it for research (e.g. legacy code being ported).
 */
export interface ReferenceEntry {
  path: string;
  role?: string;
}

/**
 * Read-only related repo: LIVE code the change must stay compatible with (the
 * other side of a bridge, an API contract, a queue, a shared table). Unlike
 * `references` (research material), these are checked for contract
 * compatibility by plan/build/review. turkeycode never branches, commits or
 * pushes in them.
 */
export interface RelatedEntry {
  path: string;
  role?: string;
}

/** `review:` block of repos.yaml (deep-tier review tuning). */
export interface ReviewConfig {
  /** Codebase-specific failure modes the reviewer must check explicitly. */
  checklist: string[];
  /** When true, `checklist` replaces the built-in default instead of extending it. */
  replaceDefaultChecklist: boolean;
}

export interface RepoManifest {
  defaultBase: string;
  branchPattern: string;
  repos: RepoEntry[];
  references: ReferenceEntry[];
  /** Read-only live repos the change must stay compatible with. Optional; loader always sets it. */
  related?: RelatedEntry[];
  /** Deep-tier review tuning. Optional; loader always sets it. */
  review?: ReviewConfig;
  /** Jira status to transition the ticket to after a successful coding push. */
  transitionAfterPush: string;
}

export const DEFAULT_MANIFEST_PATH = join(homedir(), '.turkeycode', 'repos.yaml');
export const DEFAULT_BRANCH_PATTERN = 'ticket/{key}';
export const DEFAULT_BASE = 'develop';
export const DEFAULT_TRANSITION_AFTER_PUSH = 'In Review';

export function loadRepoManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): RepoManifest | null {
  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, 'utf-8');
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid repos.yaml at ${manifestPath}: expected a YAML object`);
  }

  const p = parsed as Record<string, unknown>;
  const defaultBase = typeof p.defaultBase === 'string' ? p.defaultBase : DEFAULT_BASE;
  const branchPattern = typeof p.branchPattern === 'string' ? p.branchPattern : DEFAULT_BRANCH_PATTERN;
  const transitionAfterPush =
    typeof p.transitionAfterPush === 'string' ? p.transitionAfterPush : DEFAULT_TRANSITION_AFTER_PUSH;

  if (!Array.isArray(p.repos) || p.repos.length === 0) {
    throw new Error(`Invalid repos.yaml at ${manifestPath}: 'repos' must be a non-empty array`);
  }

  const repos: RepoEntry[] = p.repos.map((r, idx) => {
    if (!r || typeof r !== 'object') {
      throw new Error(`repos.yaml: entry at index ${idx} is not an object`);
    }
    const entry = r as Record<string, unknown>;
    if (typeof entry.path !== 'string' || !entry.path) {
      throw new Error(`repos.yaml: entry at index ${idx} is missing required 'path'`);
    }
    return {
      path: resolvePath(entry.path),
      role: typeof entry.role === 'string' ? entry.role : undefined,
      base: typeof entry.base === 'string' ? entry.base : defaultBase,
      start: typeof entry.start === 'string' ? entry.start : undefined,
      healthcheck: typeof entry.healthcheck === 'string' ? entry.healthcheck : undefined,
    };
  });

  const references: ReferenceEntry[] = Array.isArray(p.references)
    ? p.references.map((r, idx) => {
        if (!r || typeof r !== 'object') {
          throw new Error(`repos.yaml: references[${idx}] is not an object`);
        }
        const entry = r as Record<string, unknown>;
        if (typeof entry.path !== 'string' || !entry.path) {
          throw new Error(`repos.yaml: references[${idx}] is missing required 'path'`);
        }
        return {
          path: resolvePath(entry.path),
          role: typeof entry.role === 'string' ? entry.role : undefined,
        };
      })
    : [];

  const related: RelatedEntry[] = Array.isArray(p.related)
    ? p.related.map((r, idx) => {
        if (!r || typeof r !== 'object') {
          throw new Error(`repos.yaml: related[${idx}] is not an object`);
        }
        const entry = r as Record<string, unknown>;
        if (typeof entry.path !== 'string' || !entry.path) {
          throw new Error(`repos.yaml: related[${idx}] is missing required 'path'`);
        }
        return {
          path: resolvePath(entry.path),
          role: typeof entry.role === 'string' ? entry.role : undefined,
        };
      })
    : [];
  if (p.related !== undefined && !Array.isArray(p.related)) {
    throw new Error(`repos.yaml: 'related' must be a list of { path, role }`);
  }
  // A related repo is read-only; listing it under `repos` too would let the build write to it.
  const repoPaths = new Set(repos.map((r) => r.path));
  for (const r of related) {
    if (repoPaths.has(r.path)) {
      throw new Error(`repos.yaml: ${r.path} is listed in both 'repos' and 'related' — pick one`);
    }
  }

  const review = parseReviewConfig(p.review);

  return { defaultBase, branchPattern, repos, references, related, review, transitionAfterPush };
}

function parseReviewConfig(raw: unknown): ReviewConfig {
  if (raw === undefined || raw === null) return { checklist: [], replaceDefaultChecklist: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`repos.yaml: 'review' must be an object`);
  }
  const r = raw as Record<string, unknown>;
  let checklist: string[] = [];
  if (r.checklist !== undefined) {
    if (!Array.isArray(r.checklist)) {
      throw new Error(`repos.yaml: review.checklist must be a list of strings`);
    }
    checklist = r.checklist.map((item, idx) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`repos.yaml: review.checklist[${idx}] must be a non-empty string`);
      }
      return item.trim();
    });
  }
  if (r.replaceDefaultChecklist !== undefined && typeof r.replaceDefaultChecklist !== 'boolean') {
    throw new Error(`repos.yaml: review.replaceDefaultChecklist must be true or false`);
  }
  return { checklist, replaceDefaultChecklist: r.replaceDefaultChecklist === true };
}

/** Built-in failure modes the deep-tier reviewer checks on every ticket. */
export const DEFAULT_REVIEW_CHECKLIST: readonly string[] = [
  'Sentinel / literal values: legacy fields that hold placeholders or magic literals instead of real data (placeholder serials, magic codes, off-by-one encodings). Are they treated as real keys, deduplicated, or turned into records?',
  'Both directions of every integration: what this side sends, what the other side reads, and the reverse. A field one side writes that the other side has no slot for is a defect.',
  'Field ownership: when two systems run in parallel, which side owns each field? Does this change overwrite the other side\'s values, or echo them back?',
  'Bypass paths: can the rule be skipped by editing a different field or through a different entry point (header vs line, import vs add, reservation vs item)?',
  'Re-entry: identical message re-sent, out-of-order message, a soft-deleted row coming back (revive vs re-insert), absent vs empty list.',
  'Concurrency: two messages or requests for the same record at the same time (duplicate rows, lost updates).',
  'Tests that encode the premise: is the fixture data realistic, or does it bake in the assumption under review so the test passes for the wrong reason?',
  'Constructor / signature churn: every caller and test that builds or calls the changed class or function is updated.',
  'Consistency with the rest of the module: does a new helper, clock, time zone, config value or rule apply to just this feature while the rest of the code does the same thing differently? A fix that makes one feature disagree with its neighbours is a defect.',
  'Stale read-modify-write: does any existing path read a record, do slow work (a network call, a download), then save the whole record back? If the new code changes that record\'s state, that path can now overwrite it. Check for locks or re-reads.',
  'Who else must act: does this change need something outside the diff to be usable or safe (a UI that sends the new field, a permissions/provisioning list, the other side of an integration, a follow-up ticket)? Flag each one that is missing.',
  'Data source exists: does every table, column, setting or config key the change reads actually get populated (seeded, migrated, bridged in, or editable in a UI)? A feature reading data that nothing fills is inert, and a half-filled source (switch populated, table not) can be worse than none.',
  'Invariants across records: does a rule that legacy enforces across several records (one per customer, one open per unit, unique per store) still hold when the cloud spreads the decision over time or across separate drafts and requests? Check for a lock or a re-check at the moment of commit.',
  'Legacy write conventions: when the change writes a record the legacy system also writes, does it follow every step of the legacy write path, not just the first assignment (sign flips, +1 encodings, defaults filled in by a later routine, fields set by the add/rewrite routine itself)?',
];

/** Checklist the reviewer gets: default + manifest items, or manifest items only when replaceDefaultChecklist. */
export function effectiveReviewChecklist(manifest: RepoManifest): string[] {
  const review = manifest.review;
  if (!review) return [...DEFAULT_REVIEW_CHECKLIST];
  if (review.replaceDefaultChecklist) return [...review.checklist];
  return [...DEFAULT_REVIEW_CHECKLIST, ...review.checklist];
}

function resolvePath(p: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
  return resolve(expanded);
}

export function slugify(text: string, maxLen: number = 50): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

export function renderBranchName(pattern: string, params: { key: string; slug?: string }): string {
  let name = pattern.replace('{key}', params.key);
  if (params.slug) name = name.replace('{slug}', params.slug);
  // Leave placeholders intact if no slug provided — caller should supply both if pattern uses both
  return name.replace(/\s+/g, '-').replace(/[^A-Za-z0-9/_.-]/g, '-');
}

export type PreflightIssueKind =
  | 'path-missing'
  | 'not-a-repo'
  | 'dirty-tree'
  | 'fetch-failed'
  | 'base-missing'
  | 'pull-failed';

export interface PreflightIssue {
  repo: string;
  kind: PreflightIssueKind;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

export interface PreflightOptions {
  allowDirty?: boolean;
  /** Skip network fetch (useful for tests). */
  skipFetch?: boolean;
  /**
   * --base-local: repo path → local ref. Those repos skip the fetch and the
   * origin/<base> check; the local ref must resolve instead.
   */
  localBases?: Map<string, string>;
}

export function preflightRepos(manifest: RepoManifest, opts: PreflightOptions = {}): PreflightResult {
  const issues: PreflightIssue[] = [];

  for (const repo of manifest.repos) {
    if (!existsSync(repo.path)) {
      issues.push({ repo: repo.path, kind: 'path-missing', detail: 'path does not exist on disk' });
      continue;
    }
    if (!existsSync(join(repo.path, '.git'))) {
      issues.push({ repo: repo.path, kind: 'not-a-repo', detail: 'no .git directory' });
      continue;
    }

    if (!opts.allowDirty) {
      try {
        const status = execSync('git status --porcelain', { cwd: repo.path, encoding: 'utf-8' }).trim();
        if (status.length > 0) {
          issues.push({
            repo: repo.path,
            kind: 'dirty-tree',
            detail: 'uncommitted changes present (pass --dirty-ok to override)',
          });
          continue;
        }
      } catch (err) {
        issues.push({ repo: repo.path, kind: 'dirty-tree', detail: `git status failed: ${String(err)}` });
        continue;
      }
    }

    const localRef = opts.localBases?.get(repo.path);
    if (localRef) {
      if (!refResolves(repo.path, localRef)) {
        issues.push({ repo: repo.path, kind: 'base-missing', detail: `local ref ${localRef} not found` });
      }
      continue;
    }

    if (!opts.skipFetch) {
      try {
        execSync('git fetch --quiet', { cwd: repo.path, stdio: 'pipe' });
      } catch (err) {
        issues.push({ repo: repo.path, kind: 'fetch-failed', detail: String(err) });
        continue;
      }
    }

    try {
      execSync(`git rev-parse --verify origin/${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
    } catch {
      issues.push({ repo: repo.path, kind: 'base-missing', detail: `origin/${repo.base} not found` });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Check out base branch and fast-forward to origin. Returns the resulting HEAD SHA.
 * Throws if the pull can't fast-forward (means local base diverged — user must resolve).
 */
export function syncBase(repo: RepoEntry): string {
  execSync(`git fetch origin ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
  execSync(`git checkout ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
  execSync(`git pull --ff-only origin ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: repo.path, encoding: 'utf-8' }).trim();
}

/**
 * Create or reuse the ticket branch. If the branch already exists locally, check it out;
 * otherwise cut a fresh branch off the (already synced) base.
 */
export function cutTicketBranch(repo: RepoEntry, branchName: string, startPoint: string = repo.base): void {
  try {
    execSync(`git rev-parse --verify refs/heads/${branchName}`, { cwd: repo.path, stdio: 'pipe' });
    execSync(`git checkout ${branchName}`, { cwd: repo.path, stdio: 'pipe' });
  } catch {
    execSync(`git checkout -b ${branchName} ${startPoint}`, { cwd: repo.path, stdio: 'pipe' });
  }
}

// ==================== --base-local ====================

/** Conservative ref syntax check — refs are interpolated into git commands. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/@^~-]*$/;

export function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.includes('..');
}

export interface BaseLocalSpec {
  /** Bare `<ref>` item: applies to every scoped repo where it resolves. */
  defaultRef?: string;
  /** `<repoPath>=<ref>` items (paths resolved like manifest paths). */
  perRepo: Map<string, string>;
}

/**
 * Parse `--base-local`. Comma-separated items, each either `<ref>` (applies to
 * every scoped repo where the ref exists) or `<repoPath>=<ref>` (that repo
 * only, and the ref MUST exist there). At most one bare ref.
 */
export function parseBaseLocalSpec(spec: string): BaseLocalSpec {
  const out: BaseLocalSpec = { perRepo: new Map() };
  const items = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('--base-local needs a ref (or repoPath=ref pairs)');
  for (const item of items) {
    const eq = item.lastIndexOf('=');
    if (eq >= 0) {
      const path = item.slice(0, eq).trim();
      const ref = item.slice(eq + 1).trim();
      if (!path || !ref) throw new Error(`--base-local: malformed item "${item}" (want repoPath=ref)`);
      if (!isSafeRef(ref)) throw new Error(`--base-local: unsupported ref "${ref}"`);
      out.perRepo.set(resolvePath(path), ref);
    } else {
      if (!isSafeRef(item)) throw new Error(`--base-local: unsupported ref "${item}"`);
      if (out.defaultRef) throw new Error(`--base-local: more than one bare ref ("${out.defaultRef}", "${item}")`);
      out.defaultRef = item;
    }
  }
  return out;
}

/**
 * Decide which scoped repos use a local base. Explicit `path=ref` pairs win and
 * must name a scoped repo whose ref resolves (else throw). A bare ref applies to
 * every other scoped repo where it resolves; repos without it keep the normal
 * origin/<base> flow (reported in `fallback`).
 */
export function resolveLocalBases(
  repos: RepoEntry[],
  spec: BaseLocalSpec,
  refExists: (repoPath: string, ref: string) => boolean = refResolves,
): { localBases: Map<string, string>; fallback: string[] } {
  const localBases = new Map<string, string>();
  const fallback: string[] = [];
  const scoped = new Set(repos.map((r) => r.path));
  for (const [path, ref] of spec.perRepo) {
    if (!scoped.has(path)) {
      throw new Error(`--base-local: ${path} is not one of this ticket's repos (${[...scoped].join(', ')})`);
    }
    if (!refExists(path, ref)) {
      throw new Error(`--base-local: ref ${ref} does not exist in ${path}`);
    }
    localBases.set(path, ref);
  }
  for (const repo of repos) {
    if (localBases.has(repo.path)) continue;
    if (spec.defaultRef && refExists(repo.path, spec.defaultRef)) {
      localBases.set(repo.path, spec.defaultRef);
    } else if (spec.defaultRef) {
      fallback.push(repo.path);
    }
  }
  if (localBases.size === 0) {
    throw new Error(`--base-local: ref ${spec.defaultRef} does not exist in any of this ticket's repos`);
  }
  return { localBases, fallback };
}

export function refResolves(repoPath: string, ref: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, { cwd: repoPath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** --base-local counterpart of syncBase: no fetch, no checkout of the base; returns the ref's SHA. */
export function resolveLocalBase(repo: RepoEntry, ref: string): string {
  return execSync(`git rev-parse --verify ${ref}^{commit}`, { cwd: repo.path, encoding: 'utf-8' }).trim();
}

export function headSha(repoPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
}

/**
 * Has this repo accumulated commits on `branchName` beyond `baseSha`?
 * Used post-build to determine which repos were actually touched.
 */
export function repoHasCommits(repo: RepoEntry, branchName: string, baseSha: string): boolean {
  try {
    const out = execSync(`git rev-list --count ${baseSha}..${branchName}`, {
      cwd: repo.path,
      encoding: 'utf-8',
    }).trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

export interface RebaseOutcome {
  status: 'clean' | 'conflict' | 'error';
  detail?: string;
  /** Absolute paths (relative to repo) with unresolved conflicts, when status=conflict. */
  conflictedPaths?: string[];
}

/**
 * Fetch latest base and try to rebase the current branch onto origin/<base>
 * (or onto `localRef`, without fetching, under --base-local).
 * If rebase hits conflicts, leaves the repo in the "rebase in progress" state
 * and returns the list of conflicted files so a merge-fix session can resolve them.
 */
export function rebaseOntoBase(repo: RepoEntry, localRef?: string): RebaseOutcome {
  // --base-local: rebase onto the local ref as it is now (the stack may have moved); no network.
  if (!localRef) {
    try {
      execSync(`git fetch origin ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
    } catch (err) {
      return { status: 'error', detail: `fetch failed: ${String(err)}` };
    }
  }

  const onto = localRef ?? `origin/${repo.base}`;
  try {
    execSync(`git rebase ${onto}`, { cwd: repo.path, stdio: 'pipe' });
    return { status: 'clean' };
  } catch {
    // Rebase failed — check if it's a conflict we can hand off, or something else
    const conflicted = listConflictedPaths(repo.path);
    if (conflicted.length > 0) {
      return { status: 'conflict', conflictedPaths: conflicted };
    }
    return { status: 'error', detail: 'rebase failed with no conflict markers — manual intervention required' };
  }
}

export function listConflictedPaths(repoPath: string): string[] {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

export function abortRebase(repoPath: string): void {
  try {
    execSync('git rebase --abort', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    /* ignore — rebase may not be in progress */
  }
}

export function continueRebase(repoPath: string): RebaseOutcome {
  // The merge-fix session may already have finished the rebase itself (`git rebase --continue`). Then there is
  // nothing to continue and `git rebase --continue` would fail with "no rebase in progress": that is success.
  if (!rebaseInProgress(repoPath)) return { status: 'clean' };
  try {
    execSync('git rebase --continue', {
      cwd: repoPath,
      stdio: 'pipe',
      env: { ...process.env, GIT_EDITOR: 'true' },
    });
    return { status: 'clean' };
  } catch {
    const conflicted = listConflictedPaths(repoPath);
    if (conflicted.length > 0) {
      return { status: 'conflict', conflictedPaths: conflicted };
    }
    return { status: 'error', detail: 'rebase --continue failed' };
  }
}

export function rebaseInProgress(repoPath: string): boolean {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = execSync(`git rev-parse --git-path ${dir}`, { cwd: repoPath, encoding: 'utf-8' }).trim();
      if (existsSync(isAbsolute(p) ? p : join(repoPath, p))) return true;
    } catch {
      /* not a repo / git error: treat as not in progress */
    }
  }
  return false;
}

export interface PushOutcome {
  status: 'pushed' | 'error';
  detail?: string;
  /** URL to the pushed branch on the remote host, best-effort. */
  remoteUrl?: string;
}

export function pushBranch(repo: RepoEntry, branchName: string): PushOutcome {
  try {
    execSync(`git push -u origin ${branchName}`, { cwd: repo.path, stdio: 'pipe' });
  } catch (err) {
    return { status: 'error', detail: String(err) };
  }
  return { status: 'pushed', remoteUrl: deriveRemoteBranchUrl(repo.path, branchName) };
}

export function deriveRemoteBranchUrl(repoPath: string, branchName: string): string | undefined {
  try {
    const rawUrl = execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf-8' }).trim();
    // git@host:owner/repo.git  →  https://host/owner/repo/tree/<branch>
    const sshMatch = rawUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return `https://${sshMatch[1]}/${sshMatch[2]}/tree/${encodeURIComponent(branchName)}`;
    }
    // https://host/owner/repo(.git)?
    const httpsMatch = rawUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return `https://${httpsMatch[1]}/${httpsMatch[2]}/tree/${encodeURIComponent(branchName)}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
