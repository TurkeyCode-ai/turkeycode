import { describe, it, expect } from 'vitest';
import { nearestFibonacci, normalizeEstimate, formatBurndown } from '../story-orchestrator';
import { computeBurndown } from '../jira';

describe('nearestFibonacci', () => {
  it('passes through exact Fibonacci point values', () => {
    for (const f of [1, 2, 3, 5, 8, 13]) {
      expect(nearestFibonacci(f)).toBe(f);
    }
  });

  it('snaps to the nearest value', () => {
    expect(nearestFibonacci(4)).toBe(3); // tie 3 vs 5 -> smaller
    expect(nearestFibonacci(6)).toBe(5);
    expect(nearestFibonacci(7)).toBe(8);
    expect(nearestFibonacci(11)).toBe(13);
    expect(nearestFibonacci(100)).toBe(13); // clamps to top
    expect(nearestFibonacci(0)).toBe(1); // clamps to bottom
  });

  it('defaults non-finite input to 3', () => {
    expect(nearestFibonacci(NaN)).toBe(3);
    expect(nearestFibonacci(Infinity)).toBe(3);
  });
});

describe('normalizeEstimate', () => {
  it('normalizes a well-formed blob', () => {
    const e = normalizeEstimate({
      issueType: 'Bug',
      title: '  Fix the broken export  ',
      description: 'Export crashes on empty set.',
      points: 5,
      rationale: 'one place',
    });
    expect(e).toEqual({
      issueType: 'Bug',
      title: 'Fix the broken export',
      description: 'Export crashes on empty set.',
      points: 5,
      rationale: 'one place',
    });
  });

  it('snaps off-scale points to Fibonacci', () => {
    expect(normalizeEstimate({ title: 'x', points: 4 }).points).toBe(3);
    expect(normalizeEstimate({ title: 'x', points: 7 }).points).toBe(8);
  });

  it('defaults issueType to Story when unspecified', () => {
    expect(normalizeEstimate({ title: 'x' }).issueType).toBe('Story');
  });

  it('honors forceType over the model classification', () => {
    expect(normalizeEstimate({ title: 'x', issueType: 'Bug' }, 'Story').issueType).toBe('Story');
    expect(normalizeEstimate({ title: 'x', issueType: 'Story' }, 'Bug').issueType).toBe('Bug');
  });

  it('throws when there is no usable title', () => {
    expect(() => normalizeEstimate({ points: 3 })).toThrow(/title/i);
    expect(() => normalizeEstimate({ title: '   ' })).toThrow(/title/i);
  });

  it('coerces a string points value', () => {
    expect(normalizeEstimate({ title: 'x', points: '8' }).points).toBe(8);
  });
});

describe('computeBurndown', () => {
  it('sums child points and computes remaining', () => {
    const bd = computeBurndown(34, [3, 5, 8]);
    expect(bd).toEqual({ budget: 34, used: 16, remaining: 18, childCount: 3 });
  });

  it('reports null remaining when budget is unknown', () => {
    const bd = computeBurndown(null, [2, 2]);
    expect(bd.budget).toBeNull();
    expect(bd.used).toBe(4);
    expect(bd.remaining).toBeNull();
  });

  it('ignores non-numeric child points and respects an explicit childCount', () => {
    // childCount may exceed the points array when some children are unpointed.
    const bd = computeBurndown(13, [3], 4);
    expect(bd.used).toBe(3);
    expect(bd.childCount).toBe(4);
    expect(bd.remaining).toBe(10);
  });

  it('can go negative when children overcommit the budget', () => {
    expect(computeBurndown(5, [3, 5]).remaining).toBe(-3);
  });
});

describe('formatBurndown', () => {
  it('renders budgeted epics with remaining', () => {
    const out = formatBurndown('ABC-1', { budget: 34, used: 16, remaining: 18, childCount: 3 }, 5);
    expect(out).toContain('16/34');
    expect(out).toContain('18 remaining');
    expect(out).toContain('adds 5');
  });

  it('flags unbudgeted epics instead of showing a bogus remaining', () => {
    const out = formatBurndown('ABC-1', { budget: null, used: 8, remaining: null, childCount: 2 }, 3);
    expect(out).toContain('8/?');
    expect(out).toContain('no point budget');
  });
});
