import { describe, it, expect } from 'vitest';
import { Spawner, detectRateLimitSignals } from '../spawner';

describe('Spawner', () => {
  it('can be instantiated', () => {
    const spawner = new Spawner();
    expect(spawner).toBeDefined();
  });

  it('accepts verbose option', () => {
    const spawner = new Spawner({ verbose: true });
    expect(spawner).toBeDefined();
  });

  it('has run method', () => {
    const spawner = new Spawner();
    expect(typeof spawner.run).toBe('function');
  });

  it('has runParallel method', () => {
    const spawner = new Spawner();
    expect(typeof (spawner as any).runParallel).toBe('function');
  });
});

describe('detectRateLimitSignals', () => {
  it('flags a transient rate limit without marking exhaustion', () => {
    for (const text of [
      'Error: 429 Too Many Requests',
      'rate limit exceeded, retry after 30s',
      'Rate limit reached for requests',
    ]) {
      const s = detectRateLimitSignals(text);
      expect(s.rateLimited, text).toBe(true);
      expect(s.creditExhausted, text).toBe(false);
    }
  });

  it('flags credit/usage exhaustion (and implies rate-limited)', () => {
    for (const text of [
      'Your credit balance is too low to run this request',
      'insufficient credit for Agent SDK usage',
      'monthly credit exhausted — enable extra usage to continue',
      'usage limit reached; resets at the next billing cycle',
      'Please purchase more credit',
    ]) {
      const s = detectRateLimitSignals(text);
      expect(s.creditExhausted, text).toBe(true);
      expect(s.rateLimited, text).toBe(true); // exhaustion is a 429 too
    }
  });

  it('does not false-positive on normal output', () => {
    for (const text of ['Build succeeded', 'All 42 tests passed', 'Wrote docs/aar/phase-1.md']) {
      const s = detectRateLimitSignals(text);
      expect(s.rateLimited, text).toBe(false);
      expect(s.creditExhausted, text).toBe(false);
    }
  });
});
