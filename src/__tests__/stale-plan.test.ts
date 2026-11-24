/**
 * A new job must never build the previous job's plan.
 *
 * Regression seen on a client repo: after `turkeycode reset -f`, a
 * `run --spec <new spec>` logged "Plan gate already passes", skipped planning,
 * and started building the phases of the spec used two days earlier, on that
 * run's old phase branch. reset had rewritten state.json but left the plan,
 * its done marker and the per-phase markers in place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { clearRunArtifacts, planIsLeftover, specFingerprint } from '../state';
import { GitHubClient } from '../github';
import {
  PHASE_PLAN_FILE, PLAN_DONE, PHASES_DIR, QA_DIR, REVIEWS_DIR, POLISH_DIR,
  RESEARCH_DONE, SPECS_FILE, STATE_DIR, REFERENCE_DIR,
} from '../constants';

const git = (cmd: string, cwd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

describe('clearRunArtifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-stale-plan-')));
    for (const d of [REFERENCE_DIR, join(PHASES_DIR, 'phase-1'), QA_DIR, REVIEWS_DIR, POLISH_DIR]) {
      mkdirSync(join(dir, d), { recursive: true });
    }
    writeFileSync(join(dir, PHASE_PLAN_FILE), '{"phases":[]}');
    writeFileSync(join(dir, PLAN_DONE), 'DONE');
    writeFileSync(join(dir, RESEARCH_DONE), 'DONE');
    writeFileSync(join(dir, PHASES_DIR, 'phase-1', 'build.done'), 'DONE');
    writeFileSync(join(dir, SPECS_FILE), '# spec');
    writeFileSync(join(dir, STATE_DIR, 'audit.log'), 'history\n');
    writeFileSync(join(dir, STATE_DIR, 'persona.md'), 'persona');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes the plan, its marker and every per-phase and QA marker', () => {
    clearRunArtifacts(dir);
    for (const p of [PHASE_PLAN_FILE, PLAN_DONE, RESEARCH_DONE, PHASES_DIR, QA_DIR, REVIEWS_DIR, POLISH_DIR]) {
      expect(existsSync(join(dir, p)), p).toBe(false);
    }
  });

  it('keeps the spec, the persona and the audit log', () => {
    clearRunArtifacts(dir);
    expect(existsSync(join(dir, SPECS_FILE))).toBe(true);
    expect(existsSync(join(dir, STATE_DIR, 'persona.md'))).toBe(true);
    expect(existsSync(join(dir, STATE_DIR, 'audit.log'))).toBe(true);
  });

  it('is safe on a directory with nothing to clear', () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'tc-stale-empty-')));
    expect(() => clearRunArtifacts(empty)).not.toThrow();
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('planIsLeftover', () => {
  const a = specFingerprint('# spec A\n');
  const b = specFingerprint('# spec B\n');

  it('no plan on disk is never a leftover', () => {
    expect(planIsLeftover({ currentPhase: 'init' }, false, a)).toBe(false);
  });
  it('a plan beside brand-new state is a leftover (reset by an older version)', () => {
    expect(planIsLeftover({ currentPhase: 'init' }, true, a)).toBe(true);
    expect(planIsLeftover({ currentPhase: 'init' }, true, undefined)).toBe(true);
  });
  it('a plan made from a different spec is a leftover', () => {
    expect(planIsLeftover({ currentPhase: 'build', planSpecHash: a }, true, b)).toBe(true);
  });
  it('the same spec again is not a leftover, so an interrupted run carries on', () => {
    expect(planIsLeftover({ currentPhase: 'build', planSpecHash: a }, true, a)).toBe(false);
  });
  it('a run from before fingerprints existed is trusted', () => {
    expect(planIsLeftover({ currentPhase: 'build' }, true, b)).toBe(false);
  });
  it('no spec given is not a reason to discard a run under way', () => {
    expect(planIsLeftover({ currentPhase: 'build', planSpecHash: a }, true, undefined)).toBe(false);
  });
  it('line endings and outer whitespace do not change the fingerprint', () => {
    expect(specFingerprint('# spec A\r\nline\r\n\n')).toBe(specFingerprint('# spec A\nline'));
  });
});

describe('createBranch when the phase branch name is already taken', () => {
  let dir: string;
  let client: GitHubClient;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-stale-branch-')));
    git('init -b main', dir);
    git('config user.email test@example.com', dir);
    git('config user.name Test', dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add a.txt', dir);
    git('commit -m initial', dir);
    client = new GitHubClient();
    client.workDir = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restarts a leftover branch whose work is already in the base', () => {
    git('branch phase-1/thing', dir); // old run's branch, fully merged
    writeFileSync(join(dir, 'b.txt'), 'later work\n');
    git('add b.txt', dir);
    git('commit -m later', dir);
    client.createBranch('phase-1/thing', 'main');
    expect(git('rev-parse --abbrev-ref HEAD', dir)).toBe('phase-1/thing');
    expect(git('rev-parse HEAD', dir)).toBe(git('rev-parse main', dir));
  });

  it('keeps a branch that holds commits of its own (a run being resumed)', () => {
    git('checkout -b phase-1/thing', dir);
    writeFileSync(join(dir, 'c.txt'), 'in progress\n');
    git('add c.txt', dir);
    git('commit -m wip', dir);
    const wip = git('rev-parse HEAD', dir);
    git('checkout main', dir);
    client.createBranch('phase-1/thing', 'main');
    expect(git('rev-parse HEAD', dir)).toBe(wip);
  });
});
