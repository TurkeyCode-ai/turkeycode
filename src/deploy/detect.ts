/**
 * Project detection — stack & platform agnostic
 * Detects runtime, framework, database, features, and estimates hosting tier
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ==================== Types ====================

export type Runtime = 'node' | 'python' | 'go' | 'ruby' | 'rust' | 'php' | 'static' | 'docker';

export type Stack =
  // Node
  | 'nextjs' | 'express' | 'fastify' | 'nestjs' | 'remix' | 'nuxt' | 'sveltekit' | 'hono' | 'vite' | 'node'
  // Python
  | 'django' | 'flask' | 'fastapi' | 'starlette' | 'python'
  // Go
  | 'gin' | 'echo' | 'fiber' | 'chi' | 'go'
  // Ruby
  | 'rails' | 'sinatra' | 'ruby'
  // Rust
  | 'axum' | 'actix' | 'rocket' | 'warp' | 'rust'
  // PHP
  | 'laravel' | 'symfony' | 'slim' | 'php'
  // Other
  | 'static' | 'docker' | 'unknown';

export type DatabaseType = 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'redis' | false;
export type Tier = 'free' | 'starter' | 'pro' | 'business';

export interface Features {
  database: DatabaseType;
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
  runtime: Runtime;
  runtimeVersion: string;
  stack: Stack;
  hasDockerfile: boolean;
  features: Features;
  scripts: {
    install?: string;
    build?: string;
    start?: string;
    migrate?: string;
  };
  expose: number;
  tier: Tier;
  tierReason: string;
}

// ==================== Runtime Detection ====================

function detectRuntime(cwd: string): Runtime {
  // Dockerfile takes priority — developer knows best
  if (existsSync(join(cwd, 'Dockerfile'))) return 'docker';

  // Detect by project files
  if (existsSync(join(cwd, 'package.json'))) return 'node';
  if (existsSync(join(cwd, 'go.mod'))) return 'go';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(cwd, 'Gemfile'))) return 'ruby';
  if (existsSync(join(cwd, 'composer.json'))) return 'php';
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'requirements.txt')) || existsSync(join(cwd, 'setup.py'))) return 'python';
  if (existsSync(join(cwd, 'index.html'))) return 'static';

  return 'node'; // fallback
}

// ==================== Node.js Detection ====================

function detectNodeStack(deps: Record<string, string>): Stack {
  if (deps['next']) return 'nextjs';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['remix'] || deps['@remix-run/node']) return 'remix';
  if (deps['nuxt']) return 'nuxt';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps['hono']) return 'hono';
  if (deps['fastify']) return 'fastify';
  if (deps['express']) return 'express';
  if (deps['vite']) return 'vite';
  return 'node';
}

function detectNodeFeatures(deps: Record<string, string>, devDeps: Record<string, string>): Features {
  const allDeps = { ...deps, ...devDeps };
  const keys = Object.keys(allDeps);
  const hasAny = (...pkgs: string[]) => pkgs.some(p => keys.includes(p) || keys.some(k => k.startsWith(p)));

  // Determine database type
  let database: DatabaseType = false;
  if (hasAny('prisma', '@prisma/client', 'drizzle-orm', 'pg', 'postgres', 'typeorm', 'sequelize', 'knex')) database = 'postgres';
  else if (hasAny('mysql2', 'mysql')) database = 'mysql';
  else if (hasAny('mongoose', 'mongodb')) database = 'mongodb';
  else if (hasAny('better-sqlite3', 'sqlite3', 'sql.js')) database = 'sqlite';

  return {
    database,
    redis: hasAny('ioredis', 'redis', 'bull', 'bullmq', 'upstash-redis', '@upstash/redis'),
    stripe: hasAny('stripe'),
    auth: hasAny('next-auth', 'passport', '@auth/core', 'lucia', 'clerk', 'better-auth'),
    s3: hasAny('@aws-sdk/client-s3', 'aws-sdk', '@uploadthing/react', 'uploadthing'),
    email: hasAny('nodemailer', '@sendgrid/mail', 'resend', '@react-email/components', 'mailgun-js', 'postmark'),
    backgroundJobs: hasAny('bull', 'bullmq', 'node-cron', 'agenda', 'bee-queue'),
  };
}

function detectNodeProject(cwd: string): ProjectDetection {
  const pkgPath = join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  const deps = (pkg.dependencies as Record<string, string>) || {};
  const devDeps = (pkg.devDependencies as Record<string, string>) || {};
  const scripts = (pkg.scripts as Record<string, string>) || {};

  const stack = detectNodeStack({ ...deps, ...devDeps });
  const features = detectNodeFeatures(deps, devDeps);
  const { tier, reason } = estimateTier(features);

  const migrateScript = scripts['migrate'] ?? scripts['db:migrate'] ??
    (existsSync(join(cwd, 'prisma/schema.prisma')) ? 'npx prisma migrate deploy' : undefined);

  let nodeVersion = '20';
  if (pkg.engines?.node) {
    const match = pkg.engines.node.match(/\d+/);
    if (match) nodeVersion = match[0];
  }

  return {
    name: pkg.name || 'my-app',
    version: pkg.version || '1.0.0',
    runtime: 'node',
    runtimeVersion: nodeVersion,
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: 'npm ci --only=production',
      build: scripts['build'],
      start: scripts['start'] ?? 'node dist/index.js',
      migrate: migrateScript,
    },
    expose: 3000,
    tier,
    tierReason: reason,
  };
}

// ==================== Python Detection ====================

function readFileLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').map(l => l.trim().toLowerCase());
}

function detectPythonProject(cwd: string): ProjectDetection {
  const reqs = readFileLines(join(cwd, 'requirements.txt'));
  const pyproject = existsSync(join(cwd, 'pyproject.toml'))
    ? readFileSync(join(cwd, 'pyproject.toml'), 'utf-8').toLowerCase()
    : '';
  const allDeps = [...reqs, pyproject];
  const has = (...pkgs: string[]) => pkgs.some(p => allDeps.some(l => l.includes(p)));

  let stack: Stack = 'python';
  if (has('django')) stack = 'django';
  else if (has('fastapi')) stack = 'fastapi';
  else if (has('flask')) stack = 'flask';
  else if (has('starlette')) stack = 'starlette';

  let database: DatabaseType = false;
  if (has('sqlalchemy', 'alembic', 'psycopg2', 'asyncpg', 'django.db')) database = 'postgres';
  else if (has('pymysql', 'mysqlclient')) database = 'mysql';
  else if (has('pymongo', 'motor')) database = 'mongodb';
  else if (has('sqlite3', 'aiosqlite')) database = 'sqlite';

  let startCmd = 'python app.py';
  if (stack === 'django') startCmd = 'gunicorn config.wsgi:application --bind 0.0.0.0:8000';
  else if (stack === 'fastapi') startCmd = 'uvicorn app.main:app --host 0.0.0.0 --port 8000';
  else if (stack === 'flask') startCmd = 'gunicorn app:app --bind 0.0.0.0:8000';

  let migrateCmd: string | undefined;
  if (stack === 'django') migrateCmd = 'python manage.py migrate';
  else if (has('alembic')) migrateCmd = 'alembic upgrade head';

  const features: Features = {
    database,
    redis: has('redis', 'celery', 'rq'),
    stripe: has('stripe'),
    auth: has('django-allauth', 'authlib', 'python-jose', 'pyjwt'),
    s3: has('boto3', 'aiobotocore'),
    email: has('sendgrid', 'mailgun', 'smtplib'),
    backgroundJobs: has('celery', 'rq', 'huey', 'dramatiq'),
  };

  const { tier, reason } = estimateTier(features);

  // Detect Python version
  let pythonVersion = '3.12';
  if (pyproject.includes('python_requires')) {
    const match = pyproject.match(/python_requires\s*=\s*["']>=?(\d+\.\d+)/);
    if (match) pythonVersion = match[1];
  }

  return {
    name: existsSync(join(cwd, 'pyproject.toml'))
      ? (pyproject.match(/name\s*=\s*"([^"]+)"/) || [])[1] || 'my-app'
      : 'my-app',
    version: '1.0.0',
    runtime: 'python',
    runtimeVersion: pythonVersion,
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: existsSync(join(cwd, 'requirements.txt'))
        ? 'pip install -r requirements.txt'
        : 'pip install .',
      build: undefined,
      start: startCmd,
      migrate: migrateCmd,
    },
    expose: 8000,
    tier,
    tierReason: reason,
  };
}

// ==================== Go Detection ====================

function detectGoProject(cwd: string): ProjectDetection {
  const goMod = existsSync(join(cwd, 'go.mod'))
    ? readFileSync(join(cwd, 'go.mod'), 'utf-8').toLowerCase()
    : '';
  const has = (...pkgs: string[]) => pkgs.some(p => goMod.includes(p));

  let stack: Stack = 'go';
  if (has('github.com/gin-gonic/gin')) stack = 'gin';
  else if (has('github.com/labstack/echo')) stack = 'echo';
  else if (has('github.com/gofiber/fiber')) stack = 'fiber';
  else if (has('github.com/go-chi/chi')) stack = 'chi';

  let database: DatabaseType = false;
  if (has('gorm.io', 'github.com/jackc/pgx', 'github.com/lib/pq', 'github.com/jmoiron/sqlx')) database = 'postgres';
  else if (has('go.mongodb.org/mongo-driver')) database = 'mongodb';
  else if (has('modernc.org/sqlite', 'github.com/mattn/go-sqlite3')) database = 'sqlite';

  // Extract module name
  const moduleName = (goMod.match(/^module\s+(.+)/m) || [])[1] || 'my-app';
  const appName = moduleName.split('/').pop() || 'my-app';

  // Extract Go version
  const goVersion = (goMod.match(/^go\s+(\d+\.\d+)/m) || [])[1] || '1.22';

  const features: Features = {
    database,
    redis: has('github.com/redis/go-redis', 'github.com/go-redis/redis'),
    stripe: has('github.com/stripe/stripe-go'),
    auth: has('golang.org/x/oauth2', 'github.com/golang-jwt/jwt'),
    s3: has('github.com/aws/aws-sdk-go'),
    email: has('github.com/sendgrid', 'gopkg.in/gomail'),
    backgroundJobs: has('github.com/hibiken/asynq', 'github.com/robfig/cron'),
  };

  const { tier, reason } = estimateTier(features);

  return {
    name: appName,
    version: '1.0.0',
    runtime: 'go',
    runtimeVersion: goVersion,
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: 'go mod download',
      build: 'CGO_ENABLED=0 go build -o app .',
      start: './app',
      migrate: has('golang-migrate') ? 'migrate -database $DATABASE_URL -path migrations up' : undefined,
    },
    expose: 8080,
    tier,
    tierReason: reason,
  };
}

// ==================== Ruby Detection ====================

function detectRubyProject(cwd: string): ProjectDetection {
  const gemfile = readFileLines(join(cwd, 'Gemfile')).join('\n');
  const has = (...gems: string[]) => gems.some(g => gemfile.includes(g));

  let stack: Stack = 'ruby';
  if (has("'rails'", '"rails"')) stack = 'rails';
  else if (has("'sinatra'", '"sinatra"')) stack = 'sinatra';

  let database: DatabaseType = false;
  if (has("'pg'", '"pg"', 'activerecord')) database = 'postgres';
  else if (has("'mysql2'")) database = 'mysql';
  else if (has("'mongoid'")) database = 'mongodb';
  else if (has("'sqlite3'")) database = 'sqlite';

  const features: Features = {
    database,
    redis: has("'redis'", '"redis"', 'sidekiq'),
    stripe: has("'stripe'", '"stripe"'),
    auth: has('devise', 'omniauth'),
    s3: has('aws-sdk-s3', 'shrine', 'activestorage'),
    email: has('sendgrid', 'mailgun', 'actionmailer'),
    backgroundJobs: has('sidekiq', 'resque', 'delayed_job', 'good_job'),
  };

  const { tier, reason } = estimateTier(features);

  // Detect Ruby version
  let rubyVersion = '3.3';
  if (existsSync(join(cwd, '.ruby-version'))) {
    rubyVersion = readFileSync(join(cwd, '.ruby-version'), 'utf-8').trim();
  }

  return {
    name: existsSync(join(cwd, 'config/application.rb')) ? 'rails-app' : 'ruby-app',
    version: '1.0.0',
    runtime: 'ruby',
    runtimeVersion: rubyVersion,
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: 'bundle install --without development test',
      build: stack === 'rails' ? 'bundle exec rails assets:precompile' : undefined,
      start: stack === 'rails' ? 'bundle exec rails server -b 0.0.0.0 -p 3000' : 'bundle exec ruby app.rb',
      migrate: stack === 'rails' ? 'bundle exec rails db:migrate' : undefined,
    },
    expose: 3000,
    tier,
    tierReason: reason,
  };
}

// ==================== Rust Detection ====================

function detectRustProject(cwd: string): ProjectDetection {
  const cargoToml = existsSync(join(cwd, 'Cargo.toml'))
    ? readFileSync(join(cwd, 'Cargo.toml'), 'utf-8').toLowerCase()
    : '';
  const has = (...crates: string[]) => crates.some(c => cargoToml.includes(c));

  let stack: Stack = 'rust';
  if (has('axum')) stack = 'axum';
  else if (has('actix-web')) stack = 'actix';
  else if (has('rocket')) stack = 'rocket';
  else if (has('warp')) stack = 'warp';

  let database: DatabaseType = false;
  if (has('diesel', 'sqlx', 'sea-orm', 'tokio-postgres')) database = 'postgres';
  else if (has('rusqlite')) database = 'sqlite';

  // Extract package name
  const nameMatch = cargoToml.match(/\[package\][^[]*name\s*=\s*"([^"]+)"/);
  const appName = nameMatch ? nameMatch[1] : 'rust-app';

  // Extract edition as proxy for Rust version
  const edition = (cargoToml.match(/edition\s*=\s*"(\d+)"/) || [])[1] || '2021';

  const features: Features = {
    database,
    redis: has('redis', 'deadpool-redis'),
    stripe: false, // rare in Rust web apps
    auth: has('jsonwebtoken', 'oauth2', 'axum-login'),
    s3: has('aws-sdk-s3', 'rusoto'),
    email: has('lettre'),
    backgroundJobs: has('tokio-cron-scheduler'),
  };

  const { tier, reason } = estimateTier(features);

  return {
    name: appName,
    version: '1.0.0',
    runtime: 'rust',
    runtimeVersion: edition,
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: undefined,
      build: 'cargo build --release',
      start: `./target/release/${appName}`,
      migrate: has('diesel') ? 'diesel migration run' : (has('sqlx') ? 'sqlx migrate run' : undefined),
    },
    expose: 8080,
    tier,
    tierReason: reason,
  };
}

// ==================== PHP Detection ====================

function detectPhpProject(cwd: string): ProjectDetection {
  const composerPath = join(cwd, 'composer.json');
  const composer = existsSync(composerPath)
    ? JSON.parse(readFileSync(composerPath, 'utf-8'))
    : {};
  const require = composer.require || {};
  const has = (...pkgs: string[]) => pkgs.some(p => Object.keys(require).some(k => k.includes(p)));

  let stack: Stack = 'php';
  if (has('laravel/framework')) stack = 'laravel';
  else if (has('symfony/framework-bundle')) stack = 'symfony';
  else if (has('slim/slim')) stack = 'slim';

  let database: DatabaseType = false;
  if (has('doctrine', 'laravel/framework', 'illuminate/database')) database = 'postgres';
  else if (has('mongodb')) database = 'mongodb';

  const features: Features = {
    database,
    redis: has('predis', 'phpredis'),
    stripe: has('stripe/stripe-php'),
    auth: has('laravel/sanctum', 'laravel/passport', 'tymon/jwt-auth'),
    s3: has('league/flysystem-aws-s3-v3', 'aws/aws-sdk-php'),
    email: has('sendgrid', 'mailgun', 'swiftmailer'),
    backgroundJobs: has('laravel/horizon', 'php-amqplib'),
  };

  const { tier, reason } = estimateTier(features);

  return {
    name: composer.name?.split('/').pop() || 'php-app',
    version: composer.version || '1.0.0',
    runtime: 'php',
    runtimeVersion: '8.3',
    stack,
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features,
    scripts: {
      install: 'composer install --no-dev --optimize-autoloader',
      build: stack === 'laravel' ? 'php artisan optimize' : undefined,
      start: stack === 'laravel' ? 'php artisan serve --host=0.0.0.0 --port=8000' : 'php -S 0.0.0.0:8000 -t public',
      migrate: stack === 'laravel' ? 'php artisan migrate --force' : undefined,
    },
    expose: 8000,
    tier,
    tierReason: reason,
  };
}

// ==================== Static Site Detection ====================

function detectStaticProject(cwd: string): ProjectDetection {
  return {
    name: 'static-site',
    version: '1.0.0',
    runtime: 'static',
    runtimeVersion: '',
    stack: 'static',
    hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
    features: {
      database: false,
      redis: false,
      stripe: false,
      auth: false,
      s3: false,
      email: false,
      backgroundJobs: false,
    },
    scripts: {
      install: undefined,
      build: undefined,
      start: undefined,
      migrate: undefined,
    },
    expose: 80,
    tier: 'free',
    tierReason: 'static site — no backend required',
  };
}

// ==================== Docker Detection ====================

function detectDockerProject(cwd: string): ProjectDetection {
  const dockerfile = readFileSync(join(cwd, 'Dockerfile'), 'utf-8');

  // Try to extract EXPOSE port
  const exposeMatch = dockerfile.match(/^EXPOSE\s+(\d+)/m);
  const port = exposeMatch ? parseInt(exposeMatch[1]) : 3000;

  // Try to detect what's inside
  let name = 'docker-app';
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      name = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')).name || name;
    } catch {}
  }

  return {
    name,
    version: '1.0.0',
    runtime: 'docker',
    runtimeVersion: '',
    stack: 'docker',
    hasDockerfile: true,
    features: {
      database: false, // can't auto-detect from Dockerfile
      redis: false,
      stripe: false,
      auth: false,
      s3: false,
      email: false,
      backgroundJobs: false,
    },
    scripts: {
      install: undefined,
      build: `docker build -t ${name} .`,
      start: `docker run -p ${port}:${port} ${name}`,
      migrate: undefined,
    },
    expose: port,
    tier: 'starter', // Docker apps need at least starter for always-on
    tierReason: 'custom Dockerfile — requires container hosting',
  };
}

// ==================== Tier Estimation ====================

function estimateTier(features: Features): { tier: Tier; reason: string } {
  if (features.stripe || features.auth || features.s3 || features.email) {
    return { tier: 'pro', reason: 'requires Pro features (Stripe, Auth, S3, or Email)' };
  }
  if (features.database || features.redis || features.backgroundJobs) {
    return { tier: 'starter', reason: 'requires database or background services' };
  }
  return { tier: 'free', reason: 'no paid infrastructure required' };
}

// ==================== Main Entry Point ====================

export function detectProject(cwd: string): ProjectDetection {
  const runtime = detectRuntime(cwd);

  switch (runtime) {
    case 'node':    return detectNodeProject(cwd);
    case 'python':  return detectPythonProject(cwd);
    case 'go':      return detectGoProject(cwd);
    case 'ruby':    return detectRubyProject(cwd);
    case 'rust':    return detectRustProject(cwd);
    case 'php':     return detectPhpProject(cwd);
    case 'static':  return detectStaticProject(cwd);
    case 'docker':  return detectDockerProject(cwd);
    default:        throw new Error(`Unsupported runtime: ${runtime}. Add a Dockerfile for custom stacks.`);
  }
}
