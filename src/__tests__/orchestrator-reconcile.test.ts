import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isBuildDoneStale } from '../orchestrator';
import { PHASE_PLAN_FILE, PHASES_DIR } from '../constants';

/**
 * Regression coverage for the replan-on-done reconcile bug: a new iteration
 * renumbers its phases 1..N and reuses the same on-disk paths, so a prior
 * iteration's `build.done` must be treated as stale once the plan is regenerated.
 * Trusting a stale marker let a replanned run "complete" without building.
 */
describe('isBuildDoneStale', () => {
  let workDir: string;
  let buildDonePath: string;

  const planPath = () => join(workDir, PHASE_PLAN_FILE);
  const touch = (p: string, secondsAgo: number) => {
    const t = Date.now() / 1000 - secondsAgo;
    utimesSync(p, t, t);
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'turkey-reconcile-'));
    mkdirSync(join(workDir, PHASES_DIR, 'phase-1'), { recursive: true });
    buildDonePath = join(workDir, PHASES_DIR, 'phase-1', 'build.done');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns true when phase-plan.json is newer than build.done (replan)', () => {
    writeFileSync(buildDonePath, 'ok');
    writeFileSync(planPath(), '{}');
    touch(buildDonePath, 100); // built earlier
    touch(planPath(), 1); // replanned just now
    expect(isBuildDoneStale(workDir, buildDonePath)).toBe(true);
  });

  it('returns false when build.done is newer than the plan (genuine resume)', () => {
    writeFileSync(planPath(), '{}');
    writeFileSync(buildDonePath, 'ok');
    touch(planPath(), 100);
    touch(buildDonePath, 1);
    expect(isBuildDoneStale(workDir, buildDonePath)).toBe(false);
  });

  it('returns false when there is no plan file (nothing to compare against)', () => {
    writeFileSync(buildDonePath, 'ok');
    expect(isBuildDoneStale(workDir, buildDonePath)).toBe(false);
  });

  it('returns false when build.done is absent', () => {
    writeFileSync(planPath(), '{}');
    expect(isBuildDoneStale(workDir, buildDonePath)).toBe(false);
  });
});
