/**
 * isGitRepo() must ask "is workDir ITSELF a repo root?", never "am I
 * somewhere inside a repo?".
 *
 * The regression these tests exist for: isGitRepo() ran
 * `git rev-parse --git-dir` with no cwd, so it answered about the directory
 * turkeycode was launched from, and --git-dir succeeds anywhere inside a
 * repo. A build directory nested under an unrelated repo therefore reported
 * "already a repo", initRepo() skipped `git init`, and every later git call
 * — checkout main, phase branches, commits, repacks — hit the ANCESTOR repo.
 *
 * In the wild that meant a build under the user's home directory found the
 * home repo, repacked an object store covering their whole home folder,
 * wrote 34GB of temp packs, filled the disk, and died mid-write to
 * .turkey/state.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { realpathSync } from 'fs';

import { GitHubClient } from '../github';

const git = (cmd: string, cwd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

/** A repo with one commit, so HEAD is born and rev-parse behaves normally. */
function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git('init -b main', dir);
  git('config user.email test@example.com', dir);
  git('config user.name Test', dir);
  writeFileSync(join(dir, 'README.md'), '# parent\n');
  git('add -A', dir);
  git('commit -m initial', dir);
}

function clientFor(workDir: string): GitHubClient {
  const c = new GitHubClient();
  // realpath: on macOS /tmp is a symlink to /private/tmp, and the comparison
  // inside isGitRepo resolves both sides — the test must too.
  c.workDir = realpathSync(workDir);
  return c;
}

describe('isGitRepo: repo ROOT, not merely inside a repo', () => {
  const parent = join('/tmp', `.tc-parent-${Date.now()}`);
  const nested = join(parent, 'builds', 'my-build');

  beforeEach(() => {
    makeRepo(parent);
    mkdirSync(nested, { recursive: true });
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true }));

  it('is FALSE for a build dir nested inside someone else\'s repo', () => {
    // The whole bug: this used to be true, so initRepo() never ran and every
    // git operation landed on `parent`.
    //
    // This doubles as the "doesn't consult process.cwd()" assertion: vitest
    // runs with cwd = turkeycode's own repo, so an implementation that omits
    // `cwd: this.workDir` sees a perfectly good repo and returns true here.
    expect(clientFor(nested).isGitRepo()).toBe(false);
  });

  it('is TRUE for the repo root itself', () => {
    expect(clientFor(parent).isGitRepo()).toBe(true);
  });

  it('is TRUE once the build dir gets its own repo, even while nested', () => {
    git('init -b main', nested);
    expect(clientFor(nested).isGitRepo()).toBe(true);
  });

  it('a nested init keeps git operations inside the build dir', () => {
    git('init -b main', nested);
    const top = execSync('git rev-parse --show-toplevel', { cwd: nested })
      .toString()
      .trim();
    expect(realpathSync(top)).toBe(realpathSync(nested));
    // And the ancestor is untouched — still on its own branch, one commit.
    const parentLog = execSync('git log --oneline', { cwd: parent }).toString().trim();
    expect(parentLog.split('\n')).toHaveLength(1);
  });

  it('is FALSE for a directory under no repo at all', () => {
    const orphan = join('/tmp', `.tc-orphan-${Date.now()}`);
    mkdirSync(orphan, { recursive: true });
    try {
      expect(clientFor(orphan).isGitRepo()).toBe(false);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

});
