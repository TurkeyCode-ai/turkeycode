/**
 * Multi-repo manifest loader + git preflight.
 * Reads ~/.turkeycode/repos.yaml and prepares each repo for a phase build.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'child_process';

export interface RepoEntry {
  path: string;
  role?: string;
  base: string;
  start?: string;
  healthcheck?: string;
}

export interface RepoManifest {
  defaultBase: string;
  branchPattern: string;
  repos: RepoEntry[];
}

export const DEFAULT_MANIFEST_PATH = join(homedir(), '.turkeycode', 'repos.yaml');
export const DEFAULT_BRANCH_PATTERN = 'ticket/{key}';
export const DEFAULT_BASE = 'develop';

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
    const expanded = entry.path.startsWith('~')
      ? join(homedir(), entry.path.slice(1))
      : entry.path;
    return {
      path: resolve(expanded),
      role: typeof entry.role === 'string' ? entry.role : undefined,
      base: typeof entry.base === 'string' ? entry.base : defaultBase,
      start: typeof entry.start === 'string' ? entry.start : undefined,
      healthcheck: typeof entry.healthcheck === 'string' ? entry.healthcheck : undefined,
    };
  });

  return { defaultBase, branchPattern, repos };
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
export function cutTicketBranch(repo: RepoEntry, branchName: string): void {
  try {
    execSync(`git rev-parse --verify refs/heads/${branchName}`, { cwd: repo.path, stdio: 'pipe' });
    execSync(`git checkout ${branchName}`, { cwd: repo.path, stdio: 'pipe' });
  } catch {
    execSync(`git checkout -b ${branchName} ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
  }
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
 * Fetch latest base and try to rebase the current branch onto origin/<base>.
 * If rebase hits conflicts, leaves the repo in the "rebase in progress" state
 * and returns the list of conflicted files so a merge-fix session can resolve them.
 */
export function rebaseOntoBase(repo: RepoEntry): RebaseOutcome {
  try {
    execSync(`git fetch origin ${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
  } catch (err) {
    return { status: 'error', detail: `fetch failed: ${String(err)}` };
  }

  try {
    execSync(`git rebase origin/${repo.base}`, { cwd: repo.path, stdio: 'pipe' });
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
