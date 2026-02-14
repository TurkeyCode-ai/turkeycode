/**
 * GitHub integration for turkey-enterprise-v2
 * Wraps gh CLI - skips gracefully if not available
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
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

  constructor() {
    this.available = isGitHubAvailable();
    this.authenticated = this.available && isGitHubAuthenticated();

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
    // Clean QA temp files before branch switch to avoid conflicts
    this.cleanQaTempFiles();
    const stashed = this.stashIfDirty();
    try {
      if (fromBranch) {
        execSync(`git checkout ${fromBranch}`, { stdio: 'inherit' });
      }
      try {
        execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
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
          // Stash pop failed (conflicts) — drop it and use clean branch state
          console.log('Stash pop conflicted — dropping stash, using clean branch state');
          try { execSync('git stash drop', { stdio: 'inherit' }); } catch { /* ignore */ }
          try { execSync('git checkout -- .', { stdio: 'inherit' }); } catch { /* ignore */ }
        }
      }
      return true;
    } catch (err) {
      if (stashed) this.popStash();
      console.error(`Failed to create/checkout branch: ${err}`);
      return false;
    }
  }

  /**
   * Checkout an existing branch
   */
  checkoutBranch(branchName: string): boolean {
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
   * Check if a branch exists (locally or remote)
   */
  branchExists(branchName: string): boolean {
    try {
      // Check local
      execSync(`git rev-parse --verify ${branchName}`, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    try {
      this.cleanTrackedIgnoredFiles();
      execSync('git add -A', { stdio: 'inherit' });
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
    if (!this.hasRemote()) {
      console.log(`Skipping push (no remote configured): ${branchName}`);
      return false;
    }
    try {
      execSync(`git push -u origin ${branchName}`, { stdio: 'inherit' });
      console.log(`Pushed branch: ${branchName}`);
      return true;
    } catch (err) {
      console.error(`Failed to push: ${err}`);
      return false;
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
      execSync(`git checkout ${targetBranch}`, { stdio: 'inherit' });
      execSync(`git merge ${sourceBranch}`, { stdio: 'inherit' });
      console.log(`Merged ${sourceBranch} into ${targetBranch}`);
      return true;
    } catch (err) {
      // Try to resolve conflicts by accepting theirs for state files
      try {
        execSync('git checkout --theirs .turkey/state.json', { stdio: 'inherit' });
        execSync('git add .turkey/state.json', { stdio: 'inherit' });
        execSync('git commit -m "Merge: auto-resolved state.json conflict"', { stdio: 'inherit' });
        console.log(`Merged ${sourceBranch} into ${targetBranch} (auto-resolved state.json)`);
        return true;
      } catch {
        console.error(`Failed to merge branch: ${err}`);
        return false;
      }
    }
  }

  /**
   * Get the default branch name (main or master)
   */
  getDefaultBranch(): string {
    try {
      // Check what branches exist
      const branches = execSync('git branch --list', { encoding: 'utf-8' });
      if (branches.includes('main')) return 'main';
      if (branches.includes('master')) return 'master';
      // Fall back to checking git config
      const configured = execSync('git config init.defaultBranch', { encoding: 'utf-8' }).trim();
      if (configured) return configured;
    } catch { /* ignore */ }
    return 'main'; // default fallback
  }

  /**
   * Get current branch name
   */
  getCurrentBranch(): string | null {
    try {
      return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
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
      execSync('git init', { stdio: 'inherit' });
      console.log('Initialized git repository');
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

    // Find a unique repo name — append -2, -3, etc. if name is taken
    let candidateName = repoName;
    let suffix = 1;
    while (true) {
      const fullName = `${owner}/${candidateName}`;
      try {
        execSync(`gh repo view ${fullName}`, { stdio: ['pipe', 'pipe', 'pipe'] });
        // Repo exists — try next suffix
        suffix++;
        candidateName = `${repoName}-${suffix}`;
        console.log(`Repo ${fullName} already exists, trying ${candidateName}...`);
      } catch {
        // Repo doesn't exist — use this name
        break;
      }
    }

    const fullName = `${owner}/${candidateName}`;

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
      const url = `https://github.com/${repoFullName}.git`;

      // Check if origin exists
      try {
        execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] });
        // Origin exists, update it
        execSync(`git remote set-url origin ${url}`, { stdio: 'inherit' });
      } catch {
        // Origin doesn't exist, add it
        execSync(`git remote add origin ${url}`, { stdio: 'inherit' });
      }

      console.log(`Set origin to: ${url}`);
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
