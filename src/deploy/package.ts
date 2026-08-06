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
  // Env files carry secrets and must never ship in the image. `.env` + `.env.*`
  // covers every variant (.env.local, .env.production, .env.staging, …) at any
  // depth — the previous list missed .env.production/.env.development, so a
  // monorepo's backend/.env.production was tarred and uploaded off-box. Config is
  // injected at deploy time (turkey deploy --env), not baked into the tarball.
  '.env',
  '.env.*',
  '.turkey',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  // Build/dev caches — can explode to hundreds of MB and are never needed
  // at runtime. `.next/dev` is Turbopack's dev-mode cache (observed at 574MB
  // on a small project); `.next/cache` is the Webpack build cache.
  '.next/cache',
  '.next/dev',
  '.next/trace',
  '.turbo',
  '.turbopack',
  '.parcel-cache',
  '.vite',
  '.swc',
  // Test/coverage artifacts — generated, not deployable
  'coverage',
  '.nyc_output',
  'test-results',
  'playwright-report',
  // IDE/editor state
  '.idea',
  '.vscode',
];

// Files/dirs to include in the tarball (if they exist)
const INCLUDE_CANDIDATES = [
  // Source code
  'src',
  'app',
  'pages',
  'components',
  'lib',
  'utils',
  'hooks',
  'styles',
  'server',
  'api',
  // Build output
  '.next',
  'dist',
  'build',
  'out',
  // Data / config
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
  'next-env.d.ts',
  'tsconfig.json',
  'postcss.config.js',
  'postcss.config.mjs',
  'tailwind.config.js',
  'tailwind.config.ts',
  // App entry points
  'index.js',
  'index.ts',
  'main.js',
  'main.ts',
  'server.js',
  'server.ts',
  'app.js',
  'app.ts',
  'app.py',
  'main.py',
  'manage.py',
  'main.go',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile',
  'Gemfile.lock',
  'requirements.txt',
  'pyproject.toml',
  'composer.json',
  'composer.lock',
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

/**
 * Whether a top-level directory entry is dropped from the tarball by EXCLUDE_PATTERNS.
 * Mirrors tar's --exclude glob semantics for the "Packaging:" log — an exact-string
 * check would miss glob patterns like `.env.*` and falsely list secret env files as
 * packaged. Path-scoped patterns (containing '/') never hide a top-level entry.
 */
export function isExcludedEntry(entry: string, patterns: string[] = EXCLUDE_PATTERNS): boolean {
  return patterns.some(p => {
    if (p.includes('/')) return false;
    if (p.includes('*')) {
      const rx = p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${rx}$`).test(entry);
    }
    return p === entry;
  });
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

  // Guard: make sure there's something deployable at the root.
  if (getIncludeFiles(cwd).length === 0) {
    throw new Error('No deployable files found. Run your build first (npm run build).');
  }

  // Create tarball in temp dir
  const timestamp = Date.now();
  const safeName = detection.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const tarballName = `deploy-${safeName}-${timestamp}.tar.gz`;
  const tarballPath = join(tmpdir(), tarballName);

  const excludeArgs = getExcludeArgs();

  // Package the WHOLE project tree (minus excludes), not a root-only allowlist.
  // The previous allowlist matched only top-level paths, so npm-workspace
  // monorepos (source in backend/, frontend/, …) shipped a near-empty tarball
  // that failed to build server-side. Excludes already drop
  // node_modules/.git/caches, and the 500MB cap below guards runaway size.
  const included = readdirSync(cwd)
    .filter(entry => !isExcludedEntry(entry))
    .sort();

  console.log(`  Packaging: ${included.join(', ')}`);

  try {
    execSync(
      `tar -czf ${tarballPath} ${excludeArgs} .`,
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
