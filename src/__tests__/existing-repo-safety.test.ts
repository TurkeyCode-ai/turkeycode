/**
 * Running against an existing repo must not damage it.
 *
 * Regressions these tests exist for, all seen on a client repo run with
 * `--feature <branch> --no-push`:
 *  - commit() untracked every tracked file matching an ignore rule, deleting a
 *    tracked package-lock.json, Dockerfile and .env.* from the branch;
 *  - the build prompt told the agent to push, so it tried (and went looking
 *    for credentials) even under --no-push.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { GitHubClient } from '../github';
import { buildBuildPhasePrompt } from '../prompts/build';
import type { BuildPhase, ProjectState } from '../types';

const git = (cmd: string, cwd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

describe('ignored-file cleanup in an existing repo', () => {
  let dir: string;
  let client: GitHubClient;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-existing-')));
    git('init -b main', dir);
    git('config user.email test@example.com', dir);
    git('config user.name Test', dir);
    // The owner ignores these names but tracks the files anyway.
    writeFileSync(join(dir, '.gitignore'), 'package-lock.json\nDockerfile\n.env.*\nnode_modules/\n');
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, '.env.development'), 'A=1\n');
    git('add -f .gitignore package-lock.json Dockerfile .env.development', dir);
    git('commit -m initial', dir);
    client = new GitHubClient();
    client.workDir = dir;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps files the repo already tracked, and still drops newly tracked artifacts', () => {
    client.preserveTrackedRef = git('rev-parse HEAD', dir);
    mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/x/index.js'), '');
    mkdirSync(join(dir, '.turkey'));
    writeFileSync(join(dir, '.turkey/state.json'), '{}');
    git('add -f node_modules .turkey', dir);
    git('commit -m agent-commit', dir);

    client.cleanTrackedIgnoredFiles();

    const tracked = git('ls-files', dir).split('\n');
    expect(tracked).toEqual(expect.arrayContaining(['package-lock.json', 'Dockerfile', '.env.development']));
    expect(tracked).not.toContain('node_modules/x/index.js');
  });

  it('always allows turkeycode state to be untracked, even if the baseline tracked it', () => {
    mkdirSync(join(dir, '.turkey'));
    writeFileSync(join(dir, '.turkey/state.json'), '{}');
    git('add -f .turkey', dir);
    git('commit -m state', dir);
    client.preserveTrackedRef = git('rev-parse HEAD', dir);
    expect(client.filterUntrackable(['.turkey/state.json', 'Dockerfile'])).toEqual(['.turkey/state.json']);
  });

  it('untracks nothing but its own state when the baseline cannot be read', () => {
    client.preserveTrackedRef = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(client.filterUntrackable(['Dockerfile', '.turkey/x'])).toEqual(['.turkey/x']);
  });

  it('greenfield (no baseline) keeps the old behavior', () => {
    client.cleanTrackedIgnoredFiles();
    expect(git('ls-files', dir).split('\n')).toEqual(['.gitignore']);
  });
});

describe('build prompt', () => {
  it('tells the agent to commit and never push', () => {
    const state = { tech: {}, entities: [], endpoints: [], uiPages: [], knownIssues: [], buildPhases: [], projectType: 'web-backend' } as unknown as ProjectState;
    const phase = { number: 1, name: 'Foundation', scope: 's', prerequisites: [], deliverables: ['d'], acceptanceCriteria: ['a'] } as unknown as BuildPhase;
    const prompt = buildBuildPhasePrompt(state, phase);
    expect(prompt).toMatch(/never push/i);
    expect(prompt).not.toMatch(/Push when done/);
    expect(prompt).not.toMatch(/committed and pushed/);
  });
});
