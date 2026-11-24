/**
 * Screenshots that say nothing about the code must not fail a phase.
 *
 * Regression seen on a client front end: three QA attempts failed a phase
 * over a "workflows" capture that had landed on the Contacts page and a
 * Library page covered in "Failed to load" toasts from a local backend with
 * no data for it. The one real defect in that review still has to gate.
 */
import { describe, it, expect } from 'vitest';
import {
  captureProblemFor, filesNamedIn, findCaptureProblems, pagePath, parseCaptureManifest,
} from '../capture-problems';
import { mergeVisualIntoVerdict, splitVisualBlockers } from '../orchestrator';

const records = [
  { file: 'crm-desktop.png', route: '/crm', finalUrl: 'http://localhost:3000/crm?tab=all', serverErrors: 0 },
  { file: 'crm-mobile.png', route: '/crm', finalUrl: 'http://localhost:3000/crm', serverErrors: 0 },
  { file: 'workflows-desktop.png', route: '/workflows', finalUrl: 'http://localhost:3000/crm', serverErrors: 0 },
  { file: 'workflows-mobile.png', route: '/workflows', finalUrl: 'http://localhost:3000/crm/', serverErrors: 0 },
  { file: 'library-desktop.png', route: '/library', finalUrl: 'http://localhost:3000/library', serverErrors: 3 },
  { file: 'home-desktop.png', route: '/', finalUrl: 'http://localhost:3000/dashboard', serverErrors: 0 },
];
const files = records.map(r => r.file);

describe('pagePath', () => {
  it('ignores origin, query, case and a trailing slash', () => {
    expect(pagePath('http://localhost:3000/CRM/?tab=all')).toBe('/crm');
    expect(pagePath('/crm')).toBe('/crm');
    expect(pagePath('/')).toBe('/');
  });
  it('keeps the hash for hash-routed apps', () => {
    expect(pagePath('http://localhost:3000/#/crm')).toBe('/#/crm');
    expect(pagePath('/#/crm')).not.toBe(pagePath('/#/workflows'));
  });
  it('is null for nothing', () => {
    expect(pagePath(undefined)).toBeNull();
  });
});

describe('findCaptureProblems', () => {
  it('flags a capture that landed on another capture\'s page', () => {
    const problems = findCaptureProblems(records);
    expect(Object.keys(problems).sort()).toEqual(['workflows-desktop.png', 'workflows-mobile.png']);
    expect(problems['workflows-desktop.png']).toContain('asked for /workflows but landed on /crm');
  });
  it('leaves the page that was asked for and reached', () => {
    expect(findCaptureProblems(records)['crm-mobile.png']).toBeUndefined();
  });
  it('leaves a redirect to a page nobody asked for: the redirect may be the defect', () => {
    expect(findCaptureProblems(records)['home-desktop.png']).toBeUndefined();
  });
  it('flags backend failures only when the backend is outside the build', () => {
    expect(findCaptureProblems(records)['library-desktop.png']).toBeUndefined();
    expect(findCaptureProblems(records, { backendIsOutside: true })['library-desktop.png'])
      .toContain('backend failed 3 time(s)');
  });
});

describe('parseCaptureManifest', () => {
  it('reads a list or a { captures } object and drops entries with no file', () => {
    expect(parseCaptureManifest(JSON.stringify(records))).toHaveLength(records.length);
    expect(parseCaptureManifest(JSON.stringify({ captures: [{ file: 'a.png' }, { route: '/x' }] }))).toHaveLength(1);
  });
  it('is empty for a missing or unreadable manifest', () => {
    expect(parseCaptureManifest(null)).toEqual([]);
    expect(parseCaptureManifest('{ nope')).toEqual([]);
  });
});

describe('filesNamedIn', () => {
  it('finds files in the description or the location, whole names only', () => {
    expect(filesNamedIn({ description: '[crm-mobile.png] title clipped' }, files)).toEqual(['crm-mobile.png']);
    expect(filesNamedIn({ location: 'workflows-desktop.png, workflows-mobile.png' }, files))
      .toEqual(['workflows-desktop.png', 'workflows-mobile.png']);
    expect(filesNamedIn({ description: 'see my-crm-mobile.png' }, files)).toEqual([]);
  });
});

describe('the gate', () => {
  const problems = findCaptureProblems(records, { backendIsOutside: true });
  const wrongPage = { description: '[workflows-desktop.png, workflows-mobile.png] shows the Contacts page' };
  const toasts = { description: '[library-desktop.png] Failed to load exercises toasts cover the header' };
  const real = { description: '[crm-mobile.png] Import contacts is cut off at 390px' };
  const mixed = { description: '[crm-mobile.png, workflows-mobile.png] header clipped on both' };
  const noFile = { description: 'Buttons are different heights across pages' };
  const options = { capturedFiles: files, captureProblems: problems };
  const reviewed = { framesReviewed: files };

  it('gates only on findings that rest on sound screenshots', () => {
    const { gating, captureProblems } = splitVisualBlockers(
      { blockers: [] }, { blockers: [wrongPage, toasts, real, mixed, noFile], ...reviewed }, options
    );
    expect(gating).toEqual([real, mixed, noFile]);
    expect(captureProblems.map(b => b.description)).toEqual([wrongPage.description, toasts.description]);
  });

  it('keeps the others as warnings that say why', () => {
    const merged = mergeVisualIntoVerdict(
      { verdict: 'CLEAN', blockers: [], warnings: [] }, { blockers: [wrongPage, toasts], ...reviewed }, options
    );
    expect(merged.verdict).toBe('CLEAN');
    const warnings = (merged.warnings as Array<{ description: string }>).map(w => w.description);
    expect(warnings[0]).toMatch(/^\[not reviewed: the capture asked for \/workflows but landed on \/crm\]/);
    expect(warnings[1]).toMatch(/^\[not reviewed: the backend failed 3 time\(s\)/);
  });

  it('changes nothing when there is no manifest', () => {
    const { gating, captureProblems } = splitVisualBlockers(
      { blockers: [] }, { blockers: [wrongPage, real], ...reviewed }, { capturedFiles: files }
    );
    expect(gating).toEqual([wrongPage, real]);
    expect(captureProblems).toEqual([]);
  });

  it('captureProblemFor is null for a finding naming no file', () => {
    expect(captureProblemFor(noFile, files, problems)).toBeNull();
  });
});
