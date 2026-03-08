/**
 * Project detection — reads package.json, detects stack/db/features, estimates tier
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Stack = 'nextjs' | 'express' | 'fastify' | 'nestjs' | 'remix' | 'nuxt' | 'sveltekit' | 'vite' | 'node' | 'unknown';
export type Tier = 'free' | 'starter' | 'pro' | 'business';

export interface Features {
  database: boolean;
  redis: boolean;
  stripe: boolean;
  auth: boolean;
  s3: boolean;
  email: boolean;
  backgroundJobs: boolean;
}

export interface ProjectDetection {
  name: string;
  version: string;
  stack: Stack;
  nodeVersion: string;
  features: Features;
  scripts: {
    build?: string;
    start?: string;
    migrate?: string;
  };
  tier: Tier;
  tierReason: string;
}

function detectStack(deps: Record<string, string>): Stack {
  if (deps['next']) return 'nextjs';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['remix'] || deps['@remix-run/node']) return 'remix';
  if (deps['nuxt']) return 'nuxt';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps['fastify']) return 'fastify';
  if (deps['express']) return 'express';
  if (deps['vite']) return 'vite';
  if (deps['typescript'] || deps['ts-node']) return 'node';
  return 'unknown';
}

function detectFeatures(deps: Record<string, string>, devDeps: Record<string, string>): Features {
  const allDeps = { ...deps, ...devDeps };
  const keys = Object.keys(allDeps);

  const hasAny = (...pkgs: string[]) => pkgs.some(p => keys.includes(p) || keys.some(k => k.startsWith(p)));

  return {
    database: hasAny('prisma', '@prisma/client', 'typeorm', 'sequelize', 'drizzle-orm', 'mongoose', 'pg', 'mysql2'),
    redis: hasAny('ioredis', 'redis', 'bull', 'bullmq', 'upstash-redis'),
    stripe: hasAny('stripe'),
    auth: hasAny('next-auth', 'passport', '@auth/core', 'lucia', 'clerk', 'better-auth'),
    s3: hasAny('@aws-sdk/client-s3', 'aws-sdk', '@uploadthing/react', 'uploadthing'),
    email: hasAny('nodemailer', '@sendgrid/mail', 'resend', '@react-email/components', 'mailgun-js'),
    backgroundJobs: hasAny('bull', 'bullmq', 'node-cron', 'agenda', 'bee-queue'),
  };
}

function estimateTier(features: Features): { tier: Tier; reason: string } {
  if (features.stripe || features.auth || features.s3 || features.email) {
    return { tier: 'pro', reason: 'requires Pro features (Stripe, Auth, S3, or Email)' };
  }
  if (features.database || features.redis || features.backgroundJobs) {
    return { tier: 'starter', reason: 'requires database or Redis' };
  }
  return { tier: 'free', reason: 'no paid infrastructure required' };
}

export function detectProject(cwd: string): ProjectDetection {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json found in ${cwd}. Is this a Node.js project?`);
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    throw new Error('Failed to parse package.json');
  }

  const deps = (pkg.dependencies as Record<string, string>) || {};
  const devDeps = (pkg.devDependencies as Record<string, string>) || {};
  const scripts = (pkg.scripts as Record<string, string>) || {};

  const stack = detectStack({ ...deps, ...devDeps });
  const features = detectFeatures(deps, devDeps);
  const { tier, reason: tierReason } = estimateTier(features);

  // Find migrate script: look for common patterns
  const migrateScript = scripts['migrate'] ??
    scripts['db:migrate'] ??
    (features.database && existsSync(join(cwd, 'prisma/schema.prisma')) ? 'prisma migrate deploy' : undefined);

  // Detect node version from engines field or .nvmrc
  let nodeVersion = '20';
  if (pkg.engines && typeof pkg.engines === 'object') {
    const engNode = (pkg.engines as Record<string, string>).node;
    if (engNode) {
      const match = engNode.match(/\d+/);
      if (match) nodeVersion = match[0];
    }
  }

  return {
    name: (pkg.name as string) || 'my-app',
    version: (pkg.version as string) || '1.0.0',
    stack,
    nodeVersion,
    features,
    scripts: {
      build: scripts['build'],
      start: scripts['start'],
      migrate: migrateScript,
    },
    tier,
    tierReason,
  };
}
