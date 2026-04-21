/**
 * GitHub integration for turkey-enterprise-v2
 * Wraps gh CLI - skips gracefully if not available
 */

import { execSync } from 'child_process';
import fs, { writeFileSync, unlinkSync } from 'fs';
import path, { join } from 'path';
import { tmpdir } from 'os';

/**
 * Check if gh CLI is available
 */
export function isGitHubAvailable(): boolean {
  try {
    execSync('which gh', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh is authenticated
 */
export function isGitHubAuthenticated(): boolean {
  try {
    execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub client - wraps gh CLI
 * All methods skip gracefully if gh is not available/authenticated
 */
export class GitHubClient {
  private available: boolean;
  private authenticated: boolean;
  workDir: string;
  /** When true, push() is a silent no-op (set via --no-push or auto-detected). */
  noPush: boolean = false;
  /** When true, createPR() is a silent no-op (set via --no-pr or implied by noPush). */
  noPr: boolean = false;

  constructor() {
    this.workDir = process.cwd();
    this.available = isGitHubAvailable();
    this.authenticated = this.available && isGitHubAuthenticated();

    // Auto-detect "no push intended" setups: a remote URL that isn't a real
    // git URL (no scheme, no SCP form). Covers `git remote add origin no_push`.
    try {
      const url = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      if (url && !/(:\/\/|@.+:)/.test(url)) {
        this.noPush = true;
        this.noPr = true;
      }
    } catch { /* no remote at all — push() handles via hasRemote() */ }

    if (!this.available) {
      console.log('Warning: gh CLI not found, skipping GitHub integration');
    } else if (!this.authenticated) {
      console.log('Warning: gh not authenticated, skipping GitHub integration');
    }
  }

  /**
   * Check if GitHub operations will work
   */
  isEnabled(): boolean {
    return this.available && this.authenticated;
  }

  /**
   * Check if a git remote "origin" is configured
   */
  hasRemote(): boolean {
    try {
      execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stash uncommitted changes if the working tree is dirty
   * Returns true if changes were stashed
   */
  stashIfDirty(): boolean {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
      if (status) {
        execSync('git stash --include-untracked', { stdio: 'inherit' });
        console.log('Stashed dirty working tree');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Pop the most recent stash
   */
  popStash(): void {
    try {
      execSync('git stash pop', { stdio: 'inherit' });
      console.log('Restored stashed changes');
    } catch {
      // Ignore - stash may be empty or conflict
    }
  }

  /**
   * Remove stale .git/index.lock left behind by killed git processes.
   * Without this, all subsequent git operations fail.
   */
  removeStaleIndexLock(): void {
    const lockFile = path.join(process.cwd(), '.git', 'index.lock');
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        console.log('Removed stale .git/index.lock');
      }
    } catch { /* ignore */ }
  }

  /**
   * Clean up temp files left by QA agents (smoke tests, screenshot scripts, etc.)
   * These cause merge conflicts when switching branches.
   */
  cleanQaTempFiles(): void {
    const patterns = [
      'smoke-test*.ts', 'capture-screenshots*.ts', 'functional-test*.ts',
      'visual-test*.ts', 'seed-test*.ts'
    ];
    try {
      for (const pattern of patterns) {
        const files = execSync(`ls ${pattern} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        if (files) {
          for (const f of files.split('\n').filter(Boolean)) {
            try {
              execSync(`rm -f "${f}"`, { stdio: 'inherit' });
              console.log(`Cleaned QA temp file: ${f}`);
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Create and checkout a new branch
   */
  createBranch(branchName: string, fromBranch?: string): boolean {
    // Remove stale index.lock left by killed git processes
    this.removeStaleIndexLock();

    // Clean QA temp files before branch switch to avoid conflicts
    this.cleanQaTempFiles();

    // Preserve state.json before stash — it has latest progress and must survive branch switch
    const stateFile = path.join(process.cwd(), '.turkey', 'state.json');
    let savedState: string | null = null;
    try {
      if (fs.existsSync(stateFile)) {
        savedState = fs.readFileSync(stateFile, 'utf-8');
      }
    } catch { /* ignore */ }

    const stashed = this.stashIfDirty();
    try {
      if (fromBranch) {
        // Verify the branch actually exists before checking out
        try {
          const branches = execSync('git branch --list', { encoding: 'utf-8', cwd: this.workDir });
          if (!branches.includes(fromBranch)) {
            // Try the other common default
            const fallback = fromBranch === 'main' ? 'master' : 'main';
            if (branches.includes(fallback)) {
              console.log(`Branch '${fromBranch}' not found, using '${fallback}'`);
              fromBranch = fallback;
            }
          }
        } catch { /* no git repo yet, will fail below */ }
        execSync(`git checkout ${fromBranch}`, { stdio: 'inherit', cwd: this.workDir });
      }
      try {
        execSync(`git checkout -b ${branchName}`, { stdio: 'inherit', cwd: this.workDir });
        console.log(`Created branch: ${branchName}`);
      } catch {
        // Branch already exists — just check it out
        execSync(`git checkout ${branchName}`, { stdio: 'inherit' });
        console.log(`Checked out existing branch: ${branchName}`);
      }
      if (stashed) {
        try {
          execSync('git stash pop', { stdio: 'inherit' });
          console.log('Restored stashed changes');
        } catch {
          // Stash pop failed (conflicts) — drop stash and reset index+working tree
          console.log('Stash pop conflicted — dropping stash, resetting to clean state');
          try { execSync('git stash drop', { stdio: 'inherit' }); } catch { /* ignore */ }
          // git reset HEAD clears "unmerged" entries from the index
          try { execSync('git reset HEAD -- .', { stdio: 'inherit' }); } catch { /* ignore */ }
          try { execSync('git checkout -- .', { stdio: 'inherit' }); } catch { /* ignore */ }
        }
      }

      // Always restore state.json to the latest version (survives merge conflicts)
      if (savedState) {
        try {
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(stateFile, savedState, 'utf-8');
          // Stage it so git index is clean (no lingering "unmerged" status)
          execSync('git add .turkey/state.json', { stdio: 'inherit' });
        } catch { /* ignore */ }
      }

      return true;
    } catch (err) {
      if (stashed) this.popStash();
      // Restore state.json even on error
      if (savedState) {
        try { fs.writeFileSync(stateFile, savedState, 'utf-8'); } catch { /* ignore */ }
      }
      console.error(`Failed to create/checkout branch: ${err}`);
      return false;
    }
  }

  /**
   * Checkout an existing branch
   */
  checkoutBranch(branchName: string): boolean {
    this.removeStaleIndexLock();
    try {
      execSync(`git checkout ${branchName}`, { stdio: 'inherit' });
      console.log(`Checked out branch: ${branchName}`);
      return true;
    } catch (err) {
      console.error(`Failed to checkout branch: ${err}`);
      return false;
    }
  }

  /**
   * List all local branches.
   */
  listLocalBranches(): string[] {
    try {
      return execSync(`git for-each-ref --format='%(refname:short)' refs/heads/`, { encoding: 'utf-8' })
        .split('\n')
        .map(b => b.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Reconcile sub-branches a build agent created during a phase session.
   *
   * Some specs instruct the build agent to "branch per ticket from develop" (or
   * similar). The agent obeys, but turkeycode's phase wrapper branch ends up
   * empty and the per-ticket commits are lost when we merge the wrapper into
   * main. This method finds branches that didn't exist before the session, then
   * cherry-picks each one's unique commits onto the phase branch in order.
   *
   * Returns:
   *   { reconciled: string[], failed: string[], skipped: string[] }
   *
   * On any cherry-pick failure, aborts the cherry-pick and adds that branch to
   * `failed`. The caller decides whether to fail the phase.
   */
  reconcileSubBranches(
    phaseBranch: string,
    branchesBefore: string[]
  ): { reconciled: string[]; failed: string[]; skipped: string[] } {
    const reconciled: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    const branchesAfter = this.listLocalBranches();
    const newBranches = branchesAfter.filter(
      b => !branchesBefore.includes(b) && b !== phaseBranch
    );

    if (newBranches.length === 0) return { reconciled, failed, skipped };

    console.log(`Branch reconciliation: found ${newBranches.length} sub-branch(es) created during build:`);
    for (const b of newBranches) console.log(`  - ${b}`);

    // Make sure we're on the phase branch before cherry-picking onto it.
    try {
      execSync(`git checkout ${phaseBranch}`, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error(`Reconciliation: failed to checkout ${phaseBranch}: ${err}`);
      // Can't cherry-pick anywhere — mark all as failed.
      return { reconciled, failed: newBranches, skipped };
    }

    for (const branch of newBranches) {
      // Find the commits unique to this branch (since merge-base with phase branch).
      let commits: string[];
      try {
        const mergeBase = execSync(`git merge-base ${phaseBranch} ${branch}`, { encoding: 'utf-8' }).trim();
        commits = execSync(`git rev-list --reverse ${mergeBase}..${branch}`, { encoding: 'utf-8' })
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);
      } catch (err) {
        console.error(`Reconciliation: cannot compute commits for ${branch}: ${err}`);
        failed.push(branch);
        continue;
      }

      if (commits.length === 0) {
        skipped.push(branch);
        continue;
      }

      let branchOk = true;
      for (const sha of commits) {
        try {
          // -x records the original SHA in the commit message for traceability.
          execSync(`git cherry-pick -x ${sha}`, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch {
          console.error(`Reconciliation: cherry-pick conflict on ${sha} from ${branch} — aborting`);
          try { execSync(`git cherry-pick --abort`, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* ignore */ }
          failed.push(branch);
          branchOk = false;
          break;
        }
      }
      if (branchOk) {
        console.log(`Reconciled ${commits.length} commit(s) from ${branch} onto ${phaseBranch}`);
        reconciled.push(branch);
      }
    }

    return { reconciled, failed, skipped };
  }

  /**
   * Check if a branch exists (locally or remote)
   */
  branchExists(branchName: string): boolean {
    try {
      // Check local
      execSync(`git rev-parse --verify ${branchName}`, { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.workDir });
      return true;
    } catch {
      // Only check remote if origin is configured
      if (!this.hasRemote()) return false;
      try {
        execSync(`git ls-remote --heads origin ${branchName}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Remove tracked files that are now in .gitignore (e.g. node_modules committed before .gitignore existed)
   */
  cleanTrackedIgnoredFiles(): void {
    try {
      const ignored = execSync('git ls-files -ci --exclude-standard', { encoding: 'utf-8' }).trim();
      if (ignored) {
        const count = ignored.split('\n').length;
        console.log(`Removing ${count} tracked files now in .gitignore...`);
        execSync('git ls-files -ci --exclude-standard -z | xargs -0 git rm --cached', { stdio: 'inherit' });
      }
    } catch {
      // No ignored tracked files or git error — safe to skip
    }
  }

  /**
   * Stage all changes and commit
   */
  commit(message: string): boolean {
    this.removeStaleIndexLock();
    try {
      this.cleanTrackedIgnoredFiles();
      // Resolve any unmerged files before staging (e.g. state.json after stash conflicts)
      try {
        const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf-8' }).trim();
        if (unmerged) {
          console.log(`Resolving ${unmerged.split('\n').length} unmerged file(s)...`);
          for (const file of unmerged.split('\n').filter(Boolean)) {
            try {
              execSync(`git checkout --theirs "${file}"`, { stdio: 'inherit' });
              execSync(`git add "${file}"`, { stdio: 'inherit' });
            } catch { /* ignore individual file errors */ }
          }
        }
      } catch { /* no unmerged files */ }
      execSync('git add -A', { stdio: 'inherit' });
      // Skip quietly if nothing is staged. A common false-error is when a fix
      // session (or another nested agent) already committed its work — the
      // outer commit call would otherwise noisily fail "nothing to commit."
      try {
        execSync('git diff --cached --quiet', { stdio: 'pipe' });
        // exit 0 → nothing staged, nothing to commit
        return true;
      } catch {
        // exit non-zero → staged changes present, proceed to commit
      }
      execSync(`git commit -m "${message}"`, { stdio: 'inherit' });
      console.log(`Committed: ${message}`);
      return true;
    } catch (err) {
      console.error(`Failed to commit: ${err}`);
      return false;
    }
  }

  /**
   * Push branch to origin (skips if no remote configured)
   */
  push(branchName: string): boolean {
    if (this.noPush) {
      return false;
    }
    if (!this.hasRemote()) {
      console.log(`Skipping push (no remote configured): ${branchName}`);
      return false;
    }
    try {
      execSync(`git push -u origin ${branchName}`, { stdio: 'inherit' });
      console.log(`Pushed branch: ${branchName}`);
      return true;
    } catch {
      // Retry with force-with-lease if normal push fails (e.g. branch diverged on rebuild)
      try {
        console.log(`Normal push failed, retrying with --force-with-lease...`);
        execSync(`git push --force-with-lease -u origin ${branchName}`, { stdio: 'inherit' });
        console.log(`Force-pushed branch: ${branchName}`);
        return true;
      } catch (err) {
        console.error(`Failed to push: ${err}`);
        return false;
      }
    }
  }

  /**
   * Find an existing open PR for a given head branch
   * Returns PR number or null if none found
   */
  findExistingPR(head: string): number | null {
    if (!this.isEnabled()) return null;

    try {
      const result = execSync(`gh pr list --head ${head} --json number --limit 1`, { encoding: 'utf-8' });
      const prs = JSON.parse(result);
      return prs.length > 0 ? prs[0].number : null;
    } catch {
      return null;
    }
  }

  /**
   * Create a pull request
   * Returns PR number or null if failed/skipped
   */
  createPR(options: {
    title: string;
    body: string;
    base?: string;
    head?: string;
  }): number | null {
    if (this.noPr) return null;
    if (!this.isEnabled()) return null;

    // Write body to temp file to avoid shell escaping issues
    const bodyFile = join(tmpdir(), `pr-body-${Date.now()}.md`);

    try {
      writeFileSync(bodyFile, options.body);

      const base = options.base || 'main';
      // Escape title for shell
      const escapedTitle = options.title.replace(/"/g, '\\"');
      let cmd = `gh pr create --title "${escapedTitle}" --body-file "${bodyFile}" --base ${base}`;

      if (options.head) {
        cmd += ` --head ${options.head}`;
      }

      const result = execSync(cmd, { encoding: 'utf-8' });
      // Parse PR number from URL (format: https://github.com/owner/repo/pull/123)
      const match = result.match(/pull\/(\d+)/);
      if (match) {
        const prNumber = parseInt(match[1], 10);
        console.log(`Created PR #${prNumber}: ${options.title}`);
        return prNumber;
      }
      return null;
    } catch (err) {
      console.error(`Failed to create PR: ${err}`);
      return null;
    } finally {
      // Clean up temp file
      try { unlinkSync(bodyFile); } catch {}
    }
  }

  /**
   * Get PR status
   */
  getPRStatus(prNumber: number): { state: string; reviewDecision?: string } | null {
    if (!this.isEnabled()) return null;

    try {
      const result = execSync(
        `gh pr view ${prNumber} --json state,reviewDecision`,
        { encoding: 'utf-8' }
      );
      return JSON.parse(result);
    } catch (err) {
      console.error(`Failed to get PR status: ${err}`);
      return null;
    }
  }

  /**
   * Get PR diff
   */
  getPRDiff(prNumber: number): string | null {
    if (!this.isEnabled()) return null;

    try {
      return execSync(`gh pr diff ${prNumber}`, { encoding: 'utf-8' });
    } catch (err) {
      console.error(`Failed to get PR diff: ${err}`);
      return null;
    }
  }

  /**
   * Merge a pull request
   */
  mergePR(prNumber: number, options: { squash?: boolean; delete?: boolean } = {}): boolean {
    if (!this.isEnabled()) return false;

    try {
      let cmd = `gh pr merge ${prNumber}`;
      if (options.squash !== false) {
        cmd += ' --squash';
      }
      if (options.delete !== false) {
        cmd += ' --delete-branch';
      }

      execSync(cmd, { stdio: 'inherit' });
      console.log(`Merged PR #${prNumber}`);
      return true;
    } catch (err) {
      console.error(`Failed to merge PR: ${err}`);
      return false;
    }
  }

  /**
   * Merge one branch into another locally
   */
  mergeBranch(sourceBranch: string, targetBranch: string): boolean {
    try {
      execSync(`git checkout ${targetBranch}`, { stdio: 'inherit', cwd: this.workDir });
      execSync(`git merge ${sourceBranch}`, { stdio: 'inherit', cwd: this.workDir });
      console.log(`Merged ${sourceBranch} into ${targetBranch}`);
      return true;
    } catch (err) {
      // Try to resolve all conflicts: accept theirs (source branch has the latest code)
      try {
        // Find all unmerged files and resolve with --theirs
        const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf-8' }).trim();
        if (unmerged) {
          for (const file of unmerged.split('\n').filter(Boolean)) {
            try {
              execSync(`git checkout --theirs "${file}"`, { stdio: 'inherit' });
              execSync(`git add "${file}"`, { stdio: 'inherit' });
            } catch {
              // If --theirs fails (e.g. file deleted on one side), just add it
              try { execSync(`git add "${file}"`, { stdio: 'inherit' }); } catch { /* skip */ }
            }
          }
        }
        execSync(`git commit -m "Merge ${sourceBranch}: auto-resolved conflicts"`, { stdio: 'inherit' });
        console.log(`Merged ${sourceBranch} into ${targetBranch} (auto-resolved ${unmerged.split('\n').length} conflicts)`);
        return true;
      } catch (mergeErr) {
        // Last resort: abort the merge to leave git in a clean state
        try { execSync('git merge --abort', { stdio: 'inherit' }); } catch { /* ignore */ }
        console.error(`Failed to merge branch ${sourceBranch} into ${targetBranch}: ${mergeErr}`);
        return false;
      }
    }
  }

  /**
   * Get the default branch name (main or master)
   */
  /**
   * If on 'master' with no 'main', rename to 'main'
   */
  ensureMainBranch(cwd?: string): void {
    const opts = { encoding: 'utf-8' as const, cwd: cwd || process.cwd() };
    try {
      const branches = execSync('git branch --list', opts);
      const hasMaster = branches.split('\n').some(b => b.trim() === 'master' || b.trim() === '* master');
      const hasMain = branches.split('\n').some(b => b.trim() === 'main' || b.trim() === '* main');
      if (hasMaster && !hasMain) {
        try { execSync('git checkout master', { ...opts, stdio: 'pipe' }); } catch { /* already on it */ }
        execSync('git branch -m master main', { ...opts, stdio: 'inherit' });
        console.log('Renamed branch master → main');
      }
    } catch (err) {
      console.log(`[ensureMainBranch] skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  getDefaultBranch(): string {
    try {
      const opts = { encoding: 'utf-8' as const, cwd: this.workDir || process.cwd() };
      const branches = execSync('git branch --list', opts);
      if (branches.includes('main')) return 'main';
      if (branches.includes('master')) return 'master';
      const configured = execSync('git config init.defaultBranch', opts).trim();
      if (configured) return configured;
    } catch { /* ignore */ }
    return 'main'; // default fallback
  }

  /**
   * Get current branch name
   */
  getCurrentBranch(): string | null {
    try {
      return execSync('git branch --show-current', { encoding: 'utf-8', cwd: this.workDir }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  hasUncommittedChanges(): boolean {
    try {
      const result = execSync('git status --porcelain', { encoding: 'utf-8' });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if current directory is a git repo
   */
  isGitRepo(): boolean {
    try {
      execSync('git rev-parse --git-dir', { stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize git repo if not exists
   */
  initRepo(): boolean {
    if (this.isGitRepo()) {
      return true;
    }
    try {
      execSync('git init -b main', { stdio: 'inherit' });
      console.log('Initialized git repository (branch: main)');
      return true;
    } catch (err) {
      console.error(`Failed to init repo: ${err}`);
      return false;
    }
  }

  /**
   * Create a GitHub repo and set it as origin
   * Uses GITHUB_OWNER env var to determine where to create
   */
  createRepo(repoName: string, options: { private?: boolean; description?: string } = {}): string | null {
    if (!this.isEnabled()) return null;

    const owner = process.env.GITHUB_OWNER;
    if (!owner) {
      console.log('Warning: GITHUB_OWNER not set, cannot auto-create repo');
      return null;
    }

    const isPrivate = options.private !== false; // Default to private

    // Check if the exact repo already exists — if so, reuse it
    const fullName = `${owner}/${repoName}`;
    try {
      execSync(`gh repo view ${fullName}`, { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`Repo ${fullName} already exists — reusing it`);
      return fullName;
    } catch {
      // Repo doesn't exist — create it below
    }

    try {
      let cmd = `gh repo create ${fullName}`;
      cmd += isPrivate ? ' --private' : ' --public';
      if (options.description) {
        cmd += ` --description "${options.description}"`;
      }
      cmd += ' --confirm';

      execSync(cmd, { stdio: 'inherit' });
      console.log(`Created repo: ${fullName} (${isPrivate ? 'private' : 'public'})`);
      return fullName;
    } catch (err) {
      console.error(`Failed to create repo: ${err}`);
      return null;
    }
  }

  /**
   * Set or update the origin remote
   */
  setOrigin(repoFullName: string): boolean {
    try {
      // Embed GH_TOKEN in URL for HTTPS push auth (needed on droplets without gh credential helper)
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
      const url = token
        ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
        : `https://github.com/${repoFullName}.git`;

      // Check if origin exists
      try {
        execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] });
        // Origin exists, update it
        execSync(`git remote set-url origin ${url}`, { stdio: 'inherit' });
      } catch {
        // Origin doesn't exist, add it
        execSync(`git remote add origin ${url}`, { stdio: 'inherit' });
      }

      const displayUrl = token
        ? `https://x-access-token:***@github.com/${repoFullName}.git`
        : url;
      console.log(`Set origin to: ${displayUrl}`);
      return true;
    } catch (err) {
      console.error(`Failed to set origin: ${err}`);
      return false;
    }
  }

  /**
   * Initialize repo, create GitHub repo, and set origin
   * All-in-one setup for a new project
   */
  setupProject(repoName: string, options: { private?: boolean; description?: string } = {}): boolean {
    // 1. Init git repo locally
    if (!this.initRepo()) {
      return false;
    }

    // 2. Create GitHub repo
    const fullName = this.createRepo(repoName, options);
    if (!fullName) {
      console.log('Continuing without GitHub remote');
      return true; // Local git still works
    }

    // 3. Set origin
    if (!this.setOrigin(fullName)) {
      return false;
    }

    // 4. Initial commit and push if there are files
    if (this.hasUncommittedChanges()) {
      this.commit('Initial commit');
      this.push(this.getDefaultBranch());
    }

    return true;
  }
}

/**
 * Create a GitHub client
 */
export function createGitHubClient(): GitHubClient {
  return new GitHubClient();
}

/**
 * Helper to slugify a string for branch names
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}
