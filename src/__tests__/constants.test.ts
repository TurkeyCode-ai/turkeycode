import { describe, it, expect, afterEach } from 'vitest';
import {
  STATE_DIR,
  STATE_FILE,
  PHASE_PLAN_FILE,
  MAX_QA_ATTEMPTS,
  MAX_QA_ATTEMPTS_WARNINGS_ONLY,
  MIN_SPECS_LENGTH,
  MIN_PHASE_SCOPE_LENGTH,
  STRICT_QA,
  setStrictQA,
  PHASE_MODELS,
  getModelForPhase,
  ALL_DIRS,
} from '../constants';

describe('constants', () => {
  it('state paths are under .turkey', () => {
    expect(STATE_DIR).toBe('.turkey');
    expect(STATE_FILE).toContain('.turkey/');
    expect(PHASE_PLAN_FILE).toContain('.turkey/');
  });

  it('QA attempts are reasonable', () => {
    expect(MAX_QA_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(MAX_QA_ATTEMPTS).toBeLessThanOrEqual(10);
    expect(MAX_QA_ATTEMPTS_WARNINGS_ONLY).toBeLessThanOrEqual(MAX_QA_ATTEMPTS);
  });

  it('validation thresholds are sane', () => {
    expect(MIN_SPECS_LENGTH).toBeGreaterThan(0);
    expect(MIN_PHASE_SCOPE_LENGTH).toBeGreaterThan(0);
  });

  it('setStrictQA toggles the flag', () => {
    const original = STRICT_QA;
    setStrictQA(false);
    expect(STRICT_QA).toBe(false);
    setStrictQA(true);
    expect(STRICT_QA).toBe(true);
    setStrictQA(original);
  });

  it('all required phases have model assignments', () => {
    const requiredPhases = ['research', 'plan', 'build', 'qa-smoke', 'qa-functional', 'qa-visual', 'qa-verdict', 'qa-fix', 'code-review', 'aar'];
    for (const phase of requiredPhases) {
      expect(PHASE_MODELS[phase]).toBeDefined();
    }
  });

  it('getModelForPhase returns correct models', () => {
    expect(getModelForPhase('build')).toBe('claude-fable-5');
    expect(getModelForPhase('qa-fix')).toBe('claude-fable-5');
    expect(getModelForPhase('nonexistent')).toBeUndefined();
  });

  it('ALL_DIRS includes essential directories', () => {
    expect(ALL_DIRS).toContain('.turkey');
    expect(ALL_DIRS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('model overrides from the environment', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('TURKEYCODE_MODEL')) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('uses the table when nothing is set', () => {
    delete process.env.TURKEYCODE_MODEL;
    delete process.env.TURKEYCODE_MODEL_BUILD;
    expect(getModelForPhase('build')).toBe(PHASE_MODELS['build']);
  });

  it('a per-phase override wins', () => {
    // The actual situation: out of credit on Fable, mid-build, and `resume`
    // has no --model flag.
    process.env.TURKEYCODE_MODEL_BUILD = 'opus';
    expect(getModelForPhase('build')).toBe('opus');
    expect(getModelForPhase('code-review')).toBe(PHASE_MODELS['code-review']);
  });

  it('dashed phase names map to underscored env vars', () => {
    process.env.TURKEYCODE_MODEL_QA_FIX = 'sonnet';
    expect(getModelForPhase('qa-fix')).toBe('sonnet');
  });

  it('a global override covers everything unset', () => {
    process.env.TURKEYCODE_MODEL = 'sonnet';
    expect(getModelForPhase('build')).toBe('sonnet');
    expect(getModelForPhase('plan')).toBe('sonnet');
  });

  it('per-phase beats global', () => {
    process.env.TURKEYCODE_MODEL = 'haiku';
    process.env.TURKEYCODE_MODEL_BUILD = 'opus';
    expect(getModelForPhase('build')).toBe('opus');
    expect(getModelForPhase('plan')).toBe('haiku');
  });
});
