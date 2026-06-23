import { describe, it, expect } from 'vitest';
import { seedDataVerdict } from '../quick-check';

/**
 * The data-realism gate. The hard constraint: empty data is SOMETIMES the correct
 * answer (user-generated apps), so the gate only judges apps that ship a seed. SA
 * Coffee shipped empty because its seed hit a 406 and QA passed it (an empty list
 * still renders) — seedDataVerdict is what turns that into a blocker.
 */
describe('seedDataVerdict', () => {
  it('never gates an app with no seed (empty is correct for user-generated data)', () => {
    expect(seedDataVerdict({ hasSeed: false, seedExitOk: false, rowCount: 0 }).passed).toBe(true);
  });

  it('fails when a seeded app\'s seed errors (the SA Coffee 406 case)', () => {
    const v = seedDataVerdict({ hasSeed: true, seedExitOk: false, rowCount: null });
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/seed FAILED|empty/i);
  });

  it('fails when the seed runs clean but produces zero rows (silent failure)', () => {
    const v = seedDataVerdict({ hasSeed: true, seedExitOk: true, rowCount: 0 });
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/ZERO rows/);
  });

  it('passes when the seed populated real rows', () => {
    expect(seedDataVerdict({ hasSeed: true, seedExitOk: true, rowCount: 151 }).passed).toBe(true);
  });

  it('does not false-fail when the row count is inconclusive (null)', () => {
    expect(seedDataVerdict({ hasSeed: true, seedExitOk: true, rowCount: null }).passed).toBe(true);
  });
});
