import { describe, it, expect } from 'vitest';
import { Gates } from '../gates';

describe('Gates', () => {
  const gates = new Gates();

  describe('checkResearch', () => {
    it('fails when artifacts are missing (no .turkey dir)', () => {
      const result = gates.checkResearch();
      expect(result.passed).toBe(false);
      expect(result.gate).toBe('research');
      expect(result.artifacts.length).toBeGreaterThan(0);
    });

    it('returns a GateResult with correct shape', () => {
      const result = gates.checkResearch();
      expect(result).toHaveProperty('gate');
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('artifacts');
      expect(Array.isArray(result.artifacts)).toBe(true);
    });
  });

  describe('checkPlan', () => {
    it('fails when artifacts are missing', () => {
      const result = gates.checkPlan();
      expect(result.passed).toBe(false);
      expect(result.gate).toBe('plan');
    });
  });

  describe('checkQaVerdict', () => {
    it('fails when verdict file is missing', () => {
      const result = gates.checkQaVerdict(1, 1);
      expect(result.passed).toBe(false);
    });

    it('accepts phase and attempt numbers', () => {
      const result1 = gates.checkQaVerdict(1, 1);
      const result2 = gates.checkQaVerdict(2, 3);
      expect(result1.passed).toBe(false);
      expect(result2.passed).toBe(false);
    });
  });

  describe('gate result shape', () => {
    it('all gate checks return consistent structure', () => {
      const checks = [
        gates.checkResearch(),
        gates.checkPlan(),
        gates.checkQaVerdict(1, 1),
      ];

      for (const result of checks) {
        expect(result).toHaveProperty('gate');
        expect(result).toHaveProperty('passed');
        expect(result).toHaveProperty('artifacts');
        expect(typeof result.passed).toBe('boolean');
        expect(typeof result.gate).toBe('string');
        expect(Array.isArray(result.artifacts)).toBe(true);

        for (const artifact of result.artifacts) {
          expect(artifact).toHaveProperty('name');
          expect(artifact).toHaveProperty('exists');
          expect(artifact).toHaveProperty('valid');
        }
      }
    });
  });
});
