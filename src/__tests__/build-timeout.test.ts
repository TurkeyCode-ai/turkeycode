import { describe, it, expect } from 'vitest';
import { resolveBuildTimeoutMs } from '../ticket-orchestrator';
import { PHASE_BUILD_TIMEOUT_MS } from '../constants';

describe('resolveBuildTimeoutMs', () => {
  it('defaults to the phase build limit', () => {
    expect(resolveBuildTimeoutMs(undefined, {})).toBe(PHASE_BUILD_TIMEOUT_MS);
  });
  it('reads TURKEYCODE_BUILD_TIMEOUT_MIN', () => {
    expect(resolveBuildTimeoutMs(undefined, { TURKEYCODE_BUILD_TIMEOUT_MIN: '150' })).toBe(150 * 60_000);
  });
  it('ignores a blank env value', () => {
    expect(resolveBuildTimeoutMs(undefined, { TURKEYCODE_BUILD_TIMEOUT_MIN: ' ' })).toBe(PHASE_BUILD_TIMEOUT_MS);
  });
  it('the option wins over the env', () => {
    expect(resolveBuildTimeoutMs(45, { TURKEYCODE_BUILD_TIMEOUT_MIN: '150' })).toBe(45 * 60_000);
  });
  it('rejects zero, negatives, fractions and junk', () => {
    expect(() => resolveBuildTimeoutMs(0, {})).toThrow(/--build-timeout/);
    expect(() => resolveBuildTimeoutMs(-5, {})).toThrow();
    expect(() => resolveBuildTimeoutMs(1.5, {})).toThrow();
    expect(() => resolveBuildTimeoutMs(undefined, { TURKEYCODE_BUILD_TIMEOUT_MIN: 'abc' })).toThrow(/TURKEYCODE_BUILD_TIMEOUT_MIN/);
  });
});
