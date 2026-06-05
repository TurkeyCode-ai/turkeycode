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

  it('flags credit/usage exhaustion only when an API-error marker co-occurs', () => {
    // Real exhaustion errors carry an API-error context (429 / rate_limit_error / anthropic).
    for (const text of [
      'rate_limit_error: Your credit balance is too low to run this request',
      '429 Too Many Requests — monthly credit exhausted, enable extra usage',
      'anthropic API: usage limit reached for the Agent SDK credit',
      'Error from anthropic: please purchase more credit (rate limit)',
    ]) {
      const s = detectRateLimitSignals(text);
      expect(s.creditExhausted, text).toBe(true);
      expect(s.rateLimited, text).toBe(true); // exhaustion is a 429 too
    }
  });

  it('does NOT flag banking/fintech domain content as credit exhaustion (regression)', () => {
    // The bug that killed the deposit-account testbed build: finance apps are full of
    // "credit", "balance", "billing cycle", "insufficient funds" — none of which is an
    // API error. Without an API-error marker, these must not trip exhaustion.
    for (const text of [
      'POSTINT: account credit balance is too low; insufficient funds for withdrawal',
      'GENSTMT: statement billing cycle is monthly; applied monthly interest credit',
      'Test passed: rejects transaction when balance insufficient and credit limit reached',
      'usage limit reached on the customer card; monthly credit applied to the ledger',
    ]) {
      const s = detectRateLimitSignals(text);
      expect(s.creditExhausted, text).toBe(false);
      expect(s.rateLimited, text).toBe(false);
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
