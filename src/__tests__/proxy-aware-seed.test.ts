import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { proxyAwareSeedEnv } from '../quick-check';

/**
 * The jail has no direct egress and broken DNS - a fetch-based seed only works
 * through the egress proxy, which native fetch ignores. proxyAwareSeedEnv injects a
 * --require bootstrap that makes native fetch proxy-aware, but ONLY when a proxy is
 * set (so it's a no-op in prod / local builds).
 */
describe('proxyAwareSeedEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns undefined when no proxy env is set', () => {
    delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy; delete process.env.https_proxy;
    const dir = mkdtempSync(join(tmpdir(), 'qc-'));
    expect(proxyAwareSeedEnv(dir)).toBeUndefined();
  });

  it('writes a bootstrap and sets NODE_OPTIONS when a proxy is set', () => {
    process.env.HTTPS_PROXY = 'http://10.0.0.5:8888';
    const dir = mkdtempSync(join(tmpdir(), 'qc-'));
    const env = proxyAwareSeedEnv(dir);
    expect(env).toBeDefined();
    expect(env!.NODE_OPTIONS).toContain('--require');
    const bootPath = env!.NODE_OPTIONS.split('--require ')[1].trim().split(' ')[0];
    const boot = readFileSync(bootPath, 'utf-8');
    expect(boot).toContain('setGlobalDispatcher');
    expect(boot).toContain('EnvHttpProxyAgent');
  });
});
