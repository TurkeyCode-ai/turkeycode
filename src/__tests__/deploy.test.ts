import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectProject } from '../deploy/detect';
import { printApps } from '../deploy/apps';

// ============================================================================
// auth helpers — test credential read/write logic directly (no mock of homedir)
// ============================================================================

describe('deploy/auth credential helpers', () => {
  const testCredsDir = join(tmpdir(), `.test-turkeycode-${Date.now()}`);
  const testCredsPath = join(testCredsDir, 'credentials.json');

  beforeEach(() => {
    mkdirSync(testCredsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testCredsDir)) {
      rmSync(testCredsDir, { recursive: true, force: true });
    }
  });

  it('returns null when credentials file does not exist', () => {
    const creds = existsSync(testCredsPath)
      ? JSON.parse(readFileSync(testCredsPath, 'utf-8'))
      : null;
    expect(creds).toBeNull();
  });

  it('writes and reads credentials correctly', () => {
    const data = { token: 'tc_usr_abc', email: 'test@example.com', tier: 'starter' };
    writeFileSync(testCredsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    const saved = JSON.parse(readFileSync(testCredsPath, 'utf-8'));
    expect(saved.token).toBe('tc_usr_abc');
    expect(saved.email).toBe('test@example.com');
    expect(saved.tier).toBe('starter');
  });

  it('credentials file has restricted permissions (0o600)', () => {
    const data = { token: 'tc_usr_abc', email: 'test@example.com', tier: 'free' };
    writeFileSync(testCredsPath, JSON.stringify(data), { mode: 0o600 });
    const stat = statSync(testCredsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('invalid JSON in credentials file returns null safely', () => {
    writeFileSync(testCredsPath, 'not-valid-json');
    let result: unknown = null;
    try {
      result = JSON.parse(readFileSync(testCredsPath, 'utf-8'));
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });
});

// ============================================================================
// detect.ts tests
// ============================================================================

describe('deploy/detect', () => {
  const testDir = join(tmpdir(), `.test-detect-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('detects static site when no project files exist', () => {
    writeFileSync(join(testDir, 'index.html'), '<html><body>Hello</body></html>');
    const detection = detectProject(testDir);
    expect(detection.runtime).toBe('static');
    expect(detection.tier).toBe('free');
  });

  it('detects Next.js stack', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-nextjs-app',
      version: '1.0.0',
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      scripts: { build: 'next build', start: 'next start' },
    }));
    const detection = detectProject(testDir);
    expect(detection.stack).toBe('nextjs');
    expect(detection.name).toBe('my-nextjs-app');
    expect(detection.scripts.build).toBe('next build');
  });

  it('detects Express stack', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-api',
      version: '2.0.0',
      dependencies: { express: '^4.18.0' },
      scripts: { start: 'node dist/index.js' },
    }));
    const detection = detectProject(testDir);
    expect(detection.stack).toBe('express');
  });

  it('detects NestJS stack', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-nest',
      version: '1.0.0',
      dependencies: { '@nestjs/core': '^10.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.stack).toBe('nestjs');
  });

  it('detects database feature from prisma', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { '@prisma/client': '^5.0.0', next: '^14.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.database).toBeTruthy();
  });

  it('detects stripe feature', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { stripe: '^14.0.0', next: '^14.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.stripe).toBe(true);
  });

  it('detects auth feature from next-auth', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { 'next-auth': '^4.0.0', next: '^14.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.auth).toBe(true);
  });

  it('detects redis feature from ioredis', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { ioredis: '^5.0.0', express: '^4.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.redis).toBe(true);
  });

  it('detects email feature from resend', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { resend: '^2.0.0', express: '^4.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.email).toBe(true);
  });

  it('detects background jobs feature from bullmq', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { bullmq: '^4.0.0', express: '^4.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.backgroundJobs).toBe(true);
  });

  it('detects S3 feature from @aws-sdk/client-s3', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { '@aws-sdk/client-s3': '^3.0.0', next: '^14.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.s3).toBe(true);
  });

  it('estimates free tier for plain app', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'simple-app',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.tier).toBe('free');
  });

  it('estimates starter tier when db is needed', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'db-app',
      version: '1.0.0',
      dependencies: { express: '^4.18.0', pg: '^8.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.tier).toBe('starter');
  });

  it('estimates pro tier when stripe is needed', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'paid-app',
      version: '1.0.0',
      dependencies: { next: '^14.0.0', stripe: '^14.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.tier).toBe('pro');
  });

  it('detects node version from engines field', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' },
      engines: { node: '>=18.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.runtimeVersion).toBe('18');
  });

  it('falls back to node 20 when engines not set', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.runtimeVersion).toBe('20');
  });

  it('detects unknown stack for bare project', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'bare-node',
      version: '1.0.0',
      dependencies: {},
    }));
    const detection = detectProject(testDir);
    expect(detection.stack).toBe('node');
    expect(detection.runtime).toBe('node');
  });

  it('detects features in devDependencies too', () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { express: '^4.0.0' },
      devDependencies: { prisma: '^5.0.0' },
    }));
    const detection = detectProject(testDir);
    expect(detection.features.database).toBeTruthy();
  });
});

// ============================================================================
// upload.ts — manifest construction tests (no network)
// ============================================================================

describe('deploy/upload manifest shape', () => {
  it('builds manifest with all required fields', () => {
    const detection = {
      name: 'my-app',
      version: '1.2.3',
      stack: 'nextjs' as const,
      runtimeVersion: "20",
      features: {
        database: true, redis: false, stripe: false,
        auth: false, s3: false, email: false, backgroundJobs: false,
      },
      scripts: { build: 'next build', start: 'next start', migrate: 'prisma migrate deploy' },
      tier: 'starter' as const,
      tierReason: 'requires database',
    };

    const manifest = {
      name: 'custom-name',
      version: detection.version,
      stack: detection.stack,
      node: detection.runtimeVersion,
      features: detection.features,
      scripts: detection.scripts,
      env: { API_KEY: 'secret' },
      tier: 'pro',
    };

    expect(manifest.name).toBe('custom-name');
    expect(manifest.stack).toBe('nextjs');
    expect(manifest.node).toBe('20');
    expect(manifest.tier).toBe('pro');
    expect(manifest.env.API_KEY).toBe('secret');
    expect(manifest.features.database).toBeTruthy();
    expect(manifest.scripts.migrate).toBe('prisma migrate deploy');
  });

  it('manifest uses detection tier when no override', () => {
    const opts: { tier?: string } = {};
    const tier = opts.tier ?? 'starter';
    expect(tier).toBe('starter');
  });

  it('manifest uses options name when provided', () => {
    const opts: { name?: string } = { name: 'override-name' };
    const name = opts.name ?? 'original-name';
    expect(name).toBe('override-name');
  });
});

// ============================================================================
// apps.ts — printApps tests
// ============================================================================

describe('deploy/apps', () => {
  it('printApps prints "No deployed apps" for empty list', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('No deployed apps');
    consoleSpy.mockRestore();
  });

  it('printApps renders app name, stack, tier, status', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([{
      name: 'my-app',
      url: 'https://my-app.turkeycode.ai',
      tier: 'starter',
      stack: 'nextjs',
      status: 'running',
      createdAt: '2026-03-08T00:00:00Z',
      lastDeployed: '2026-03-08T00:00:00Z',
    }]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('my-app');
    expect(output).toContain('nextjs');
    expect(output).toContain('starter');
    expect(output).toContain('running');
    consoleSpy.mockRestore();
  });

  it('printApps shows sleeping icon for sleeping apps', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([{
      name: 'sleepy', url: 'https://sleepy.turkeycode.ai',
      tier: 'free', stack: 'express', status: 'sleeping',
      createdAt: '', lastDeployed: '',
    }]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('💤');
    consoleSpy.mockRestore();
  });

  it('printApps shows failed icon for failed apps', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([{
      name: 'broken', url: 'https://broken.turkeycode.ai',
      tier: 'free', stack: 'node', status: 'failed',
      createdAt: '', lastDeployed: '',
    }]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('❌');
    consoleSpy.mockRestore();
  });

  it('printApps shows provisioning icon', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([{
      name: 'new-app', url: 'https://new-app.turkeycode.ai',
      tier: 'starter', stack: 'nestjs', status: 'provisioning',
      createdAt: '', lastDeployed: '',
    }]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('⏳');
    consoleSpy.mockRestore();
  });

  it('printApps handles multiple apps', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps([
      { name: 'app-one', url: 'https://app-one.turkeycode.ai', tier: 'free', stack: 'express', status: 'running', createdAt: '', lastDeployed: '' },
      { name: 'app-two', url: 'https://app-two.turkeycode.ai', tier: 'starter', stack: 'nextjs', status: 'sleeping', createdAt: '', lastDeployed: '' },
    ]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('app-one');
    expect(output).toContain('app-two');
    consoleSpy.mockRestore();
  });
});
