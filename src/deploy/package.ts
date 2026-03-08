/**
 * Package the app — run build if needed, create tarball excluding noise
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import type { ProjectDetection } from './detect';

const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.env',
  '.env.local',
  '.env.*.local',
  '.turkey',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '.next/cache',
];

// Files/dirs to include in the tarball (if they exist)
const INCLUDE_CANDIDATES = [
  '.next',
  'dist',
  'build',
  'out',
  'prisma',
  'public',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'tsconfig.json',
];

export interface PackageOptions {
  skipBuild?: boolean;
  envFile?: string;
}

export interface PackageResult {
  tarballPath: string;
  sizeBytes: number;
  sizeMB: string;
}

function runBuild(cwd: string, buildScript: string): void {
  console.log(`  Running build: npm run build`);
  try {
    execSync(`npm run build`, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } catch {
    throw new Error(`Build failed. Fix build errors and try again, or use --skip-build.`);
  }
}

function needsBuild(cwd: string, stack: string): boolean {
  // Check if build output already exists
  if (stack === 'nextjs' && existsSync(join(cwd, '.next/BUILD_ID'))) return false;
  if (existsSync(join(cwd, 'dist/index.js'))) return false;
  if (existsSync(join(cwd, 'build/index.js'))) return false;
  return true;
}

function getExcludeArgs(): string {
  return EXCLUDE_PATTERNS.map(p => `--exclude='${p}'`).join(' ');
}

function getIncludeFiles(cwd: string): string[] {
  return INCLUDE_CANDIDATES.filter(f => existsSync(join(cwd, f)));
}

function getTarballSize(path: string): number {
  return statSync(path).size;
}

export async function packageApp(
  detection: ProjectDetection,
  cwd: string,
  options: PackageOptions = {}
): Promise<PackageResult> {
  // Run build if needed
  if (!options.skipBuild && detection.scripts.build) {
    if (needsBuild(cwd, detection.stack)) {
      runBuild(cwd, detection.scripts.build);
    } else {
      console.log('  Build output already exists, skipping build.');
    }
  }

  // Collect files to include
  const includes = getIncludeFiles(cwd);

  if (includes.length === 0) {
    throw new Error('No deployable files found. Run your build first (npm run build).');
  }

  // Create tarball in temp dir
  const timestamp = Date.now();
  const safeName = detection.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const tarballName = `deploy-${safeName}-${timestamp}.tar.gz`;
  const tarballPath = join(tmpdir(), tarballName);

  const excludeArgs = getExcludeArgs();
  const includeArgs = includes.join(' ');

  console.log(`  Packaging: ${includes.join(', ')}`);

  try {
    execSync(
      `tar -czf ${tarballPath} ${excludeArgs} ${includeArgs}`,
      { cwd, stdio: 'pipe' }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create tarball: ${msg}`);
  }

  const sizeBytes = getTarballSize(tarballPath);
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

  // Check 500MB limit
  if (sizeBytes > 500 * 1024 * 1024) {
    throw new Error(`Tarball too large: ${sizeMB}MB (max 500MB). Add more entries to .gitignore.`);
  }

  return { tarballPath, sizeBytes, sizeMB };
}
