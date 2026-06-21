import { describe, it, expect } from 'vitest';
import { isNoopFix } from '../orchestrator';

/**
 * A fix session that commits nothing leaves HEAD unchanged. The QA gates only
 * verify a `.done` signal (not real work), so without this check a no-op fix
 * sails through and the loop re-runs full QA on identical code — same verdict,
 * every remaining attempt burned. isNoopFix is the deterministic guard.
 */
describe('isNoopFix', () => {
  const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';

  it('is true when HEAD is unchanged from the pre-fix snapshot (no-op fix)', () => {
    expect(isNoopFix(SHA, SHA)).toBe(true);
  });

  it('is false when the fix moved HEAD (real changes committed)', () => {
    expect(isNoopFix(OTHER, SHA)).toBe(false);
  });

  it('is false when we have no pre-fix snapshot to compare against', () => {
    expect(isNoopFix(SHA, null)).toBe(false);
  });

  it('is false when HEAD can not be read (git error)', () => {
    expect(isNoopFix(null, SHA)).toBe(false);
  });
});
