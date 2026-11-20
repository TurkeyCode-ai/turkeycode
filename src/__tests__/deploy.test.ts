import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectProject } from '../deploy/detect';
import { printApps, toApp } from '../deploy/apps';
import { getCredentials, resolveToken, saveCredentials } from '../deploy/auth';

// ============================================================================
// auth — where the DigitalOcean token comes from
// ============================================================================

describe('deploy/auth token resolution', () => {
  let dir: string;
  let credsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-auth-'));
    credsPath = join(dir, 'credentials.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds nothing when there is no env var and no saved login', () => {
    expect(resolveToken({}, credsPath)).toBeNull();
  });

  it('saves the login with owner-only permissions and reads it back', () => {
    saveCredentials({ token: 'dop_v1_saved', email: 'someone@example.com' }, credsPath);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    expect(resolveToken({}, credsPath)).toEqual({ token: 'dop_v1_saved', source: 'turkeycode login' });
  });

  it('prefers the environment over the saved login', () => {
    saveCredentials({ token: 'dop_v1_saved', email: '' }, credsPath);
    expect(resolveToken({ DIGITALOCEAN_ACCESS_TOKEN: 'dop_v1_env' }, credsPath))
      .toEqual({ token: 'dop_v1_env', source: 'DIGITALOCEAN_ACCESS_TOKEN' });
    expect(resolveToken({ DIGITALOCEAN_TOKEN: ' dop_v1_other ' }, credsPath))
      .toEqual({ token: 'dop_v1_other', source: 'DIGITALOCEAN_TOKEN' });
  });

  it('treats a corrupt or token-less credentials file as no login', () => {
    writeFileSync(credsPath, 'not-valid-json');
    expect(getCredentials(credsPath)).toBeNull();
    writeFileSync(credsPath, JSON.stringify({ email: 'x@example.com' }));
    expect(getCredentials(credsPath)).toBeNull();
  });

  it('ignores a login left over from the old turkeycode.ai hosting', () => {
    writeFileSync(credsPath, JSON.stringify({ token: 'tc_usr_old', email: 'x@example.com', tier: 'starter' }));
    expect(resolveToken({}, credsPath)).toBeNull();
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
// apps.ts — droplets shown as apps
// ============================================================================

describe('deploy/apps', () => {
  function printed(apps: Parameters<typeof printApps>[0]): string {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printApps(apps);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    consoleSpy.mockRestore();
    return output;
  }

  const droplet = {
    id: 7,
    name: 'my-app',
    status: 'active',
    created_at: '2026-11-20T00:00:00Z',
    size_slug: 's-1vcpu-2gb',
    size: { price_monthly: 12 },
    region: { slug: 'nyc3' },
    tags: ['turkeycode', 'tc-stack:nextjs'],
    networks: { v4: [
      { ip_address: '10.0.0.5', type: 'private' },
      { ip_address: '203.0.113.9', type: 'public' },
    ] },
  };

  it('says so when nothing is deployed', () => {
    expect(printed([])).toContain('No deployed apps');
  });

  it('reads name, stack, size, price and public URL off a droplet', () => {
    expect(toApp(droplet)).toEqual({
      name: 'my-app',
      url: 'http://203.0.113.9',
      stack: 'nextjs',
      size: 's-1vcpu-2gb',
      region: 'nyc3',
      status: 'active',
      priceMonthly: 12,
      createdAt: '2026-11-20T00:00:00Z',
    });
  });

  it('copes with a droplet that has no address or stack tag yet', () => {
    const app = toApp({ id: 1, name: 'new-app', status: 'new', created_at: '', size_slug: 's-1vcpu-1gb' });
    expect(app.url).toBe('');
    expect(app.stack).toBe('unknown');
    expect(app.priceMonthly).toBeNull();
  });

  it('prints one row per app with its status', () => {
    const output = printed([toApp(droplet), toApp({ ...droplet, name: 'other', status: 'off' })]);
    expect(output).toContain('my-app');
    expect(output).toContain('nextjs');
    expect(output).toContain('s-1vcpu-2gb');
    expect(output).toContain('✅ active');
    expect(output).toContain('⏹ off');
    expect(output).toContain('http://203.0.113.9');
  });
});

// ============================================================================
// package.ts — "Packaging:" log must agree with tar's glob excludes
// ============================================================================

import { isExcludedEntry } from '../deploy/package';

describe('deploy/package isExcludedEntry', () => {
  it('hides glob-matched env files the way tar --exclude does', () => {
    for (const entry of ['.env', '.env.local', '.env.production', '.env.staging', '.env.example']) {
      expect(isExcludedEntry(entry), entry).toBe(true);
    }
  });

  it('hides exact-name and wildcard patterns', () => {
    expect(isExcludedEntry('node_modules')).toBe(true);
    expect(isExcludedEntry('.turkey')).toBe(true);
    expect(isExcludedEntry('build.log')).toBe(true); // *.log
  });

  it('does not hide normal project entries', () => {
    for (const entry of ['src', 'package.json', 'environment.ts', 'env', 'loggers']) {
      expect(isExcludedEntry(entry), entry).toBe(false);
    }
  });

  it('path-scoped patterns never hide a top-level entry', () => {
    // `.next/cache` is excluded, but top-level `.next` itself still ships
    expect(isExcludedEntry('.next')).toBe(false);
  });
});
