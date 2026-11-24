/**
 * Visual QA on an app whose pages sit behind sign-in.
 *
 * Regression seen on a client front end using an outside sign-in provider:
 * every capture showed the sign-in card, the reviewer reported the phase's
 * deliverables as missing, the blocker gated the phase, and two fix sessions
 * were spent on a problem that was not in the code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { mergeVisualIntoVerdict, splitVisualBlockers } from '../orchestrator';
import { signInSection, signInWallFile, visualAuthFile } from '../prompts/qa-visual';
import { VISUAL_AUTH_FILE } from '../constants';

const clean = () => ({ verdict: 'CLEAN', blockers: [], warnings: [] });
const wall = { kind: 'not-shown', description: 'Every capture shows the sign-in card; no coach page is shown' };
const broken = { kind: 'seen', description: 'Sign-in button overlaps the logo', location: 'login/mobile' };

describe('a capture stopped at sign-in', () => {
  it('does not gate on what was never photographed', () => {
    const merged = mergeVisualIntoVerdict(clean(), { blockers: [wall] }, { signInWall: true });
    expect(merged.verdict).toBe('CLEAN');
    expect(merged.blockers).toEqual([]);
    const warnings = merged.warnings as Array<{ description: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toContain('[not shown in capture]');
  });

  it('still gates on a problem the reviewer actually saw', () => {
    const { gating, notShown } = splitVisualBlockers(clean(), { blockers: [wall, broken] }, { signInWall: true });
    expect(gating).toEqual([broken]);
    expect(notShown).toEqual([wall]);
  });

  it('gates as before when the capture did reach the pages', () => {
    const visual = { blockers: [wall], framesReviewed: ['home-desktop.png'] };
    const merged = mergeVisualIntoVerdict(clean(), visual, { capturedFiles: ['home-desktop.png'] });
    expect(merged.verdict).toBe('NEEDS_FIX');
  });
});

describe('sign-in instructions in the capture prompt', () => {
  it('names the marker file for the phase and attempt', () => {
    expect(signInWallFile(2, 3)).toMatch(/phase-2\/sign-in-wall-3\.md$/);
    expect(signInSection(2, 3, null)).toContain(signInWallFile(2, 3));
  });

  it('loads a provided session and says not to expose it', () => {
    const text = signInSection(1, 1, '.turkey/visual-auth.json');
    expect(text).toContain("storageState: '.turkey/visual-auth.json'");
    expect(text).toMatch(/Never print, copy or commit/);
  });

  it('without a session, allows only documented test credentials on the app\'s own form', () => {
    const text = signInSection(1, 1, null);
    expect(text).toMatch(/documents test or seed credentials/);
    expect(text).toMatch(/outside provider/);
  });

  it('always forbids changing the app to get a screenshot', () => {
    for (const file of [null, 'x.json']) {
      const text = signInSection(1, 1, file);
      expect(text).toMatch(/Never weaken, stub, bypass or edit the app's sign-in code/);
      expect(text).toMatch(/never guess passwords, never create accounts/);
    }
  });
});

describe('visualAuthFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-visual-auth-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is null when nothing was supplied', () => {
    expect(visualAuthFile({}, dir)).toBeNull();
  });
  it('finds the file in the state folder', () => {
    mkdirSync(join(dir, '.turkey'), { recursive: true });
    writeFileSync(join(dir, VISUAL_AUTH_FILE), '{}');
    expect(visualAuthFile({}, dir)).toBe(VISUAL_AUTH_FILE);
  });
  it('prefers a file named by TURKEYCODE_VISUAL_AUTH, and ignores a path that is not there', () => {
    const elsewhere = join(dir, 'session.json');
    writeFileSync(elsewhere, '{}');
    expect(visualAuthFile({ TURKEYCODE_VISUAL_AUTH: elsewhere }, dir)).toBe(elsewhere);
    expect(visualAuthFile({ TURKEYCODE_VISUAL_AUTH: join(dir, 'missing.json') }, dir)).toBeNull();
  });
});
