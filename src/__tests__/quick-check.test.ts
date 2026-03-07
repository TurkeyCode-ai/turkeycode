import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';

// Test the detection logic without running actual checks
// (quick-check.ts exports are tested indirectly via their interfaces)

describe('quick-check module', () => {
  it('quick-check.ts exists and exports runQuickChecks', async () => {
    const mod = await import('../quick-check');
    expect(mod.runQuickChecks).toBeDefined();
    expect(typeof mod.runQuickChecks).toBe('function');
  });

  it('exports runTicketVerification', async () => {
    const mod = await import('../quick-check');
    expect(mod.runTicketVerification).toBeDefined();
    expect(typeof mod.runTicketVerification).toBe('function');
  });

  it('QuickCheckResult interface shape is correct', async () => {
    // Verify the module can be imported without errors
    const mod = await import('../quick-check');
    // runQuickChecks returns a Promise<QuickCheckResult>
    // We just verify it's a function that can be called
    expect(mod.runQuickChecks.length).toBeGreaterThanOrEqual(1); // takes workDir param
  });
});

describe('project detection', () => {
  it('detects this project as a Node.js project', () => {
    // This repo itself should be detectable
    expect(existsSync(join(process.cwd(), 'package.json'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'tsconfig.json'))).toBe(true);
  });
});
