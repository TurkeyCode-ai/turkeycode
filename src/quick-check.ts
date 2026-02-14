/**
 * Stack-agnostic quick smoke checks — fast validation before expensive QA
 *
 * Auto-detects backend, frontend, and database from project files,
 * Docker services, and environment variables. Runs in seconds.
 *
 * Supported backends:  Node.js, Go, Ruby, Python, .NET, PHP, Rust, Spring/Gradle, Elixir
 * Supported databases: PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite
 * Supported frontends: React, Vue, Angular, Svelte, Solid, Next.js, Nuxt, Astro, Remix
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════
// Public API types
// ═══════════════════════════════════════════

export interface QuickCheckResult {
  passed: boolean;
  checks: CheckResult[];
  duration: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

// ═══════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════

type BackendType = 'node' | 'go' | 'ruby' | 'python' | 'dotnet' | 'php' | 'rust' | 'spring' | 'elixir' | 'unknown';
type FrontendType = 'react' | 'vue' | 'angular' | 'svelte' | 'solid' | 'astro' | 'unknown';
type DatabaseType = 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'sqlite';

interface ProjectInfo {
  workDir: string;
  hasBackend: boolean;
  hasFrontend: boolean;
  backendType: BackendType;
  backendDir: string;
  frontendType: FrontendType;
  frontendDir: string;
  hasDocker: boolean;
  databases: DatabaseType[];
  pm: PackageManager;
  /** True when backendDir is inside a monorepo (workDir !== backendDir and workDir has workspace config) */
  isMonorepo: boolean;
}

interface ProcessHandle {
  process: ChildProcess;
  kill: () => void;
}

// ═══════════════════════════════════════════
// Detection tables — add new stacks here
// ═══════════════════════════════════════════

/** Backend detector: file to check + content matcher */
interface BackendDetector {
  type: BackendType;
  /** Files that indicate this backend (checked in order) */
  files: string[];
  /** If set, file content must match at least one pattern. If empty, file existence is enough. */
  patterns: RegExp[];
  /** For package.json-based detection: check these dependency keys */
  packageDeps?: string[];
}

const BACKEND_DETECTORS: BackendDetector[] = [
  {
    type: 'node',
    files: ['package.json'],
    patterns: [],
    packageDeps: [
      'express', 'fastify', 'koa', '@nestjs/core', 'hapi', '@hapi/hapi',
      'restify', 'polka', 'micro', 'moleculer', 'adonis-framework', '@adonisjs/core'
    ]
  },
  {
    type: 'go',
    files: ['go.mod'],
    patterns: [/gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux|net\/http|buffalo/]
  },
  {
    type: 'ruby',
    files: ['Gemfile'],
    patterns: [/\bgem\s+['"]rails['"]|gem\s+['"]sinatra['"]|gem\s+['"]grape['"]|gem\s+['"]hanami['"]/]
  },
  {
    type: 'python',
    files: ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py'],
    patterns: [/flask|fastapi|django|starlette|tornado|sanic|bottle|falcon|pyramid/i]
  },
  {
    type: 'dotnet',
    files: [], // special: scan for *.csproj / *.fsproj
    patterns: []
  },
  {
    type: 'php',
    files: ['composer.json'],
    patterns: [],
    packageDeps: [
      'laravel/framework', 'symfony/framework-bundle', 'slim/slim',
      'cakephp/cakephp', 'yiisoft/yii2', 'codeigniter4/framework'
    ]
  },
  {
    type: 'rust',
    files: ['Cargo.toml'],
    patterns: [/actix-web|axum|rocket|warp|tide|gotham|nickel/]
  },
  {
    type: 'spring',
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    patterns: [] // file existence is enough
  },
  {
    type: 'elixir',
    files: ['mix.exs'],
    patterns: [/phoenix|plug|bandit/]
  }
];

/** Database: Docker image pattern, env var patterns, readiness commands */
interface DatabaseInfo {
  type: DatabaseType;
  /** Matches docker image names */
  imagePattern: RegExp;
  /** Matches env var names/values indicating this DB */
  envPatterns: RegExp[];
  /** Readiness commands to run via docker exec (tried in order) */
  dockerReadiness: string[];
  /** Readiness commands to run locally (tried in order) */
  localReadiness: string[];
  /** Node.js driver module name (for require-based connection test) */
  nodeDriver: string;
  /** Default port */
  defaultPort: number;
  /** Regex to extract connection string from .env */
  connectionStringPattern: RegExp;
}

const DATABASE_INFO: DatabaseInfo[] = [
  {
    type: 'postgres',
    imagePattern: /postgres/i,
    envPatterns: [/DATABASE_URL.*postgres/i, /^PGHOST=/m, /^POSTGRES_HOST=/m],
    dockerReadiness: ['pg_isready -U postgres'],
    localReadiness: ['pg_isready'],
    nodeDriver: 'pg',
    defaultPort: 5432,
    connectionStringPattern: /(?:DATABASE_URL|POSTGRES_URL)\s*=\s*(.+)/i
  },
  {
    type: 'mysql',
    imagePattern: /mysql|mariadb/i,
    envPatterns: [/DATABASE_URL.*mysql/i, /^MYSQL_HOST=/m, /^MARIADB_HOST=/m],
    dockerReadiness: ['mysqladmin ping -h 127.0.0.1 --silent', 'mariadb-admin ping -h 127.0.0.1 --silent'],
    localReadiness: ['mysqladmin ping --silent'],
    nodeDriver: 'mysql2',
    defaultPort: 3306,
    connectionStringPattern: /(?:DATABASE_URL|MYSQL_URL)\s*=\s*(.+)/i
  },
  {
    type: 'mongodb',
    imagePattern: /mongo/i,
    envPatterns: [/^MONGO_URI=/m, /^MONGODB_URI=/m, /^MONGO_URL=/m, /DATABASE_URL.*mongodb/i],
    dockerReadiness: ['mongosh --eval "db.runCommand({ping:1})" --quiet', 'mongo --eval "db.runCommand({ping:1})" --quiet'],
    localReadiness: ['mongosh --eval "db.runCommand({ping:1})" --quiet'],
    nodeDriver: 'mongodb',
    defaultPort: 27017,
    connectionStringPattern: /(?:MONGO_URI|MONGODB_URI|MONGO_URL|DATABASE_URL)\s*=\s*(mongodb.+)/i
  },
  {
    type: 'redis',
    imagePattern: /redis|valkey|dragonfly/i,
    envPatterns: [/^REDIS_URL=/m, /^REDIS_HOST=/m],
    dockerReadiness: ['redis-cli ping'],
    localReadiness: ['redis-cli ping'],
    nodeDriver: 'redis',
    defaultPort: 6379,
    connectionStringPattern: /(?:REDIS_URL)\s*=\s*(.+)/i
  }
];

/** Build config per backend type */
interface BuildConfig {
  /** Commands to try for compilation check (first success wins) */
  buildCmds: { cmd: string; condition?: string; label: string }[];
  /** Install command if node_modules/vendor is missing */
  installCmd?: string;
  /** Timeout for build commands in ms */
  timeoutMs: number;
}

const BUILD_CONFIG: Record<BackendType, BuildConfig> = {
  node: {
    buildCmds: [
      { cmd: 'npx tsc --noEmit', condition: 'tsconfig.json', label: 'TypeScript compile' },
      { cmd: 'npm run build', condition: 'package.json', label: 'npm build' }
    ],
    installCmd: 'npm install',
    timeoutMs: 60000
  },
  go: {
    buildCmds: [
      { cmd: 'go build ./...', label: 'Go build' }
    ],
    timeoutMs: 120000
  },
  ruby: {
    buildCmds: [
      { cmd: 'bundle exec rails db:prepare --trace', condition: 'bin/rails', label: 'Rails db:prepare' },
      { cmd: 'bundle check', label: 'Bundle check' }
    ],
    installCmd: 'bundle install',
    timeoutMs: 120000
  },
  python: {
    buildCmds: [
      { cmd: 'python -m py_compile $(find . -name "*.py" -not -path "./venv/*" -not -path "./.venv/*" | head -20 | tr "\\n" " ")', label: 'Python compile check' },
      { cmd: 'python -c "import compileall; compileall.compile_dir(\'.\', quiet=1)"', label: 'Python compileall' }
    ],
    installCmd: 'pip install -r requirements.txt',
    timeoutMs: 60000
  },
  dotnet: {
    buildCmds: [
      { cmd: 'dotnet build --no-restore', label: '.NET build' }
    ],
    installCmd: 'dotnet restore',
    timeoutMs: 120000
  },
  php: {
    buildCmds: [
      { cmd: 'php artisan --version', condition: 'artisan', label: 'Laravel artisan' },
      { cmd: 'composer validate', label: 'Composer validate' }
    ],
    installCmd: 'composer install --no-interaction',
    timeoutMs: 60000
  },
  rust: {
    buildCmds: [
      { cmd: 'cargo check', label: 'Cargo check' }
    ],
    timeoutMs: 180000
  },
  spring: {
    buildCmds: [
      { cmd: './mvnw compile -q', condition: 'mvnw', label: 'Maven compile' },
      { cmd: './gradlew compileJava -q', condition: 'gradlew', label: 'Gradle compile' },
      { cmd: 'mvn compile -q', condition: 'pom.xml', label: 'Maven compile' },
      { cmd: 'gradle compileJava -q', condition: 'build.gradle', label: 'Gradle compile' }
    ],
    timeoutMs: 180000
  },
  elixir: {
    buildCmds: [
      { cmd: 'mix compile --warnings-as-errors', label: 'Mix compile' }
    ],
    installCmd: 'mix deps.get',
    timeoutMs: 120000
  },
  unknown: {
    buildCmds: [],
    timeoutMs: 60000
  }
};

/** Start config per backend type */
interface StartConfig {
  /** Commands to try for starting the server */
  startCmds: { cmd: string; condition?: string }[];
  /** Default port if not detected from config */
  defaultPort: number;
  /** Common health check paths to try */
  healthPaths: string[];
}

const START_CONFIG: Record<BackendType, StartConfig> = {
  node: {
    startCmds: [
      { cmd: 'PORT=4000 npm start', condition: 'package.json' },
      { cmd: 'PORT=4000 npm run dev', condition: 'package.json' }
    ],
    defaultPort: 4000,
    healthPaths: ['/api/health', '/health', '/healthz', '/api/v1/health', '/ping']
  },
  go: {
    startCmds: [
      { cmd: 'go run .', condition: 'main.go' },
      { cmd: 'go run ./cmd/server', condition: 'cmd/server' }
    ],
    defaultPort: 8080,
    healthPaths: ['/health', '/healthz', '/api/health', '/ping']
  },
  ruby: {
    startCmds: [
      { cmd: 'bundle exec rails server -d -p 4000', condition: 'bin/rails' },
      { cmd: 'bundle exec rackup -p 4000', condition: 'config.ru' }
    ],
    defaultPort: 4000,
    healthPaths: ['/health', '/up', '/api/health', '/rails/health']
  },
  python: {
    startCmds: [
      { cmd: 'python manage.py runserver 0.0.0.0:8000', condition: 'manage.py' },
      { cmd: 'uvicorn main:app --host 0.0.0.0 --port 8000', condition: 'main.py' },
      { cmd: 'uvicorn app.main:app --host 0.0.0.0 --port 8000', condition: 'app/main.py' },
      { cmd: 'python app.py', condition: 'app.py' },
      { cmd: 'gunicorn app:app', condition: 'app.py' }
    ],
    defaultPort: 8000,
    healthPaths: ['/health', '/api/health', '/ping', '/api/v1/health']
  },
  dotnet: {
    startCmds: [
      { cmd: 'dotnet run' }
    ],
    defaultPort: 5000,
    healthPaths: ['/health', '/healthz', '/api/health']
  },
  php: {
    startCmds: [
      { cmd: 'php artisan serve', condition: 'artisan' },
      { cmd: 'php -S localhost:8000 -t public', condition: 'public/index.php' }
    ],
    defaultPort: 8000,
    healthPaths: ['/health', '/api/health', '/up']
  },
  rust: {
    startCmds: [
      { cmd: 'cargo run' }
    ],
    defaultPort: 8080,
    healthPaths: ['/health', '/healthz', '/api/health']
  },
  spring: {
    startCmds: [
      { cmd: './mvnw spring-boot:run', condition: 'mvnw' },
      { cmd: './gradlew bootRun', condition: 'gradlew' }
    ],
    defaultPort: 8080,
    healthPaths: ['/actuator/health', '/health', '/api/health']
  },
  elixir: {
    startCmds: [
      { cmd: 'mix phx.server', condition: 'mix.exs' }
    ],
    defaultPort: 4000,
    healthPaths: ['/health', '/api/health', '/healthz']
  },
  unknown: {
    startCmds: [],
    defaultPort: 4000,
    healthPaths: ['/health', '/api/health']
  }
};

/** Frontend framework detection from package.json deps */
const FRONTEND_DEPS: Array<{ deps: string[]; type: FrontendType }> = [
  { deps: ['react', 'react-dom', 'next', 'remix', 'gatsby', '@remix-run/react'], type: 'react' },
  { deps: ['vue', 'nuxt', 'nuxt3'], type: 'vue' },
  { deps: ['@angular/core'], type: 'angular' },
  { deps: ['svelte', '@sveltejs/kit'], type: 'svelte' },
  { deps: ['solid-js', '@solidjs/start'], type: 'solid' },
  { deps: ['astro'], type: 'astro' }
];

// ═══════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════

function runCommand(cmd: string, cwd: string, timeoutMs: number = 30000): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, output: output || '' };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.message || 'Command failed' };
  }
}

interface StartResult {
  handle: ProcessHandle | null;
  /** Captured stderr+stdout (last 500 chars) for diagnostics on failure */
  output: string;
  /** 'ready' | 'timeout' | 'crashed' | 'error' */
  reason: string;
}

function startProcess(cmd: string, cwd: string, readyCheck: (output: string) => Promise<boolean>, timeoutMs: number = 15000, env?: Record<string, string>): Promise<StartResult> {
  return new Promise((resolve) => {
    let outputBuf = '';
    const captureOutput = (data: Buffer) => {
      outputBuf += data.toString();
      // Keep last 1000 chars
      if (outputBuf.length > 1000) outputBuf = outputBuf.slice(-1000);
    };

    const proc = spawn(cmd, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      detached: true,
      env: env ? { ...process.env, ...env } : process.env
    });

    proc.stdout?.on('data', captureOutput);
    proc.stderr?.on('data', captureOutput);

    const handle: ProcessHandle = {
      process: proc,
      kill: () => {
        try {
          if (proc.pid) {
            try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
          }
          proc.kill('SIGTERM');
        } catch {}
      }
    };

    const startTime = Date.now();
    const checkInterval = setInterval(async () => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        handle.kill();
        resolve({ handle: null, output: outputBuf.trim(), reason: 'timeout' });
        return;
      }
      try {
        if (await readyCheck(outputBuf)) {
          clearInterval(checkInterval);
          resolve({ handle, output: outputBuf.trim(), reason: 'ready' });
        }
      } catch {}
    }, 500);

    proc.on('error', (err) => {
      clearInterval(checkInterval);
      resolve({ handle: null, output: outputBuf.trim() || err.message, reason: 'error' });
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearInterval(checkInterval);
        resolve({ handle: null, output: outputBuf.trim(), reason: 'crashed' });
      }
    });
  });
}

async function checkPort(port: number, host: string = 'localhost'): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

function getComposeCommand(workDir: string): string {
  if (runCommand('docker compose version', workDir, 5000).success) return 'docker compose';
  if (runCommand('docker-compose version', workDir, 5000).success) return 'docker-compose';
  return 'docker compose';
}

/** Read a file safely, return empty string on failure */
function safeRead(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf-8') : ''; }
  catch { return ''; }
}

/** Read and parse JSON safely */
function safeReadJson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; }
  catch { return null; }
}

/** Collect all .env content from common locations as raw string */
function readEnvFiles(workDir: string, backendDir: string): string {
  const envPaths = new Set([
    join(workDir, '.env'),
    join(workDir, '.env.local'),
    join(backendDir, '.env'),
    join(backendDir, '.env.local')
  ]);
  let combined = '';
  for (const p of envPaths) {
    combined += safeRead(p) + '\n';
  }
  return combined;
}

/** Detect which package manager a project uses */
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

function detectPackageManager(workDir: string): PackageManager {
  if (existsSync(join(workDir, 'pnpm-lock.yaml')) || existsSync(join(workDir, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (existsSync(join(workDir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(workDir, 'bun.lockb')) || existsSync(join(workDir, 'bun.lock'))) return 'bun';
  // Also check packageManager field in package.json
  const pkg = safeReadJson(join(workDir, 'package.json'));
  if (pkg?.packageManager) {
    if (pkg.packageManager.startsWith('pnpm')) return 'pnpm';
    if (pkg.packageManager.startsWith('yarn')) return 'yarn';
    if (pkg.packageManager.startsWith('bun')) return 'bun';
  }
  return 'npm';
}

/** Get the install command for a package manager */
function pmInstall(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm': return 'pnpm install';
    case 'yarn': return 'yarn install';
    case 'bun': return 'bun install';
    default: return 'npm install';
  }
}

/** Get the run command for a package manager */
function pmRun(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'pnpm': return `pnpm run ${script}`;
    case 'yarn': return `yarn ${script}`;
    case 'bun': return `bun run ${script}`;
    default: return `npm run ${script}`;
  }
}

/** Get the exec command for a package manager */
function pmExec(pm: PackageManager, cmd: string): string {
  switch (pm) {
    case 'pnpm': return `pnpm exec ${cmd}`;
    case 'yarn': return `yarn ${cmd}`;
    case 'bun': return `bunx ${cmd}`;
    default: return `npx ${cmd}`;
  }
}

/** Parse .env files into a key-value object. Later files override earlier ones. */
function loadEnvFiles(...paths: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of paths) {
    const content = safeRead(p);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

// ═══════════════════════════════════════════
// Stack detection
// ═══════════════════════════════════════════

function detectBackend(dir: string): { type: BackendType; found: boolean } {
  for (const detector of BACKEND_DETECTORS) {
    // Special case: .NET scans for *.csproj/*.fsproj
    if (detector.type === 'dotnet') {
      try {
        const files = readdirSync(dir);
        if (files.some(f => f.endsWith('.csproj') || f.endsWith('.fsproj'))) {
          return { type: 'dotnet', found: true };
        }
      } catch {}
      continue;
    }

    // Check if any indicator files exist
    for (const file of detector.files) {
      const filePath = join(dir, file);
      if (!existsSync(filePath)) continue;

      // package.json-based: check dependency keys
      if (detector.packageDeps && file === 'package.json') {
        const pkg = safeReadJson(filePath);
        if (!pkg) continue;
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (detector.packageDeps.some(dep => allDeps?.[dep])) {
          return { type: detector.type, found: true };
        }
        continue;
      }

      // composer.json-based: check require keys
      if (detector.packageDeps && file === 'composer.json') {
        const composer = safeReadJson(filePath);
        if (!composer) continue;
        const allDeps = { ...composer.require, ...composer['require-dev'] };
        if (detector.packageDeps.some(dep => allDeps?.[dep])) {
          return { type: detector.type, found: true };
        }
        continue;
      }

      // Pattern-based: read file content and check patterns
      if (detector.patterns.length > 0) {
        const content = safeRead(filePath);
        if (detector.patterns.some(p => p.test(content))) {
          return { type: detector.type, found: true };
        }
        continue;
      }

      // No patterns = file existence is enough
      return { type: detector.type, found: true };
    }
  }
  return { type: 'unknown', found: false };
}

function detectFrontend(dir: string): { type: FrontendType; found: boolean } {
  const pkg = safeReadJson(join(dir, 'package.json'));
  if (!pkg) return { type: 'unknown', found: false };
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const fe of FRONTEND_DEPS) {
    if (fe.deps.some(dep => allDeps?.[dep])) {
      return { type: fe.type, found: true };
    }
  }
  // Has package.json with vite/webpack/parcel = some kind of frontend
  if (allDeps?.vite || allDeps?.webpack || allDeps?.parcel || allDeps?.esbuild) {
    return { type: 'unknown', found: true };
  }
  return { type: 'unknown', found: false };
}

function detectDatabases(workDir: string, backendDir: string): DatabaseType[] {
  const found = new Set<DatabaseType>();

  // 1. Check running Docker containers
  try {
    const ps = execSync('docker ps --format "{{.Image}}"', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const line of ps.trim().split('\n').filter(Boolean)) {
      for (const db of DATABASE_INFO) {
        if (db.imagePattern.test(line)) found.add(db.type);
      }
    }
  } catch {}

  // 2. Check compose files
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const file of composeFiles) {
    const content = safeRead(join(workDir, file));
    if (!content) continue;
    for (const db of DATABASE_INFO) {
      if (db.imagePattern.test(content)) found.add(db.type);
    }
  }

  // 3. Check .env files
  const envContent = readEnvFiles(workDir, backendDir);
  for (const db of DATABASE_INFO) {
    if (db.envPatterns.some(p => p.test(envContent))) found.add(db.type);
  }

  // 4. Check for SQLite files
  const sqliteFiles = ['db.sqlite3', 'database.sqlite', 'data.db', 'app.db', 'dev.db'];
  const dirsToCheck = [workDir, backendDir];
  for (const dir of dirsToCheck) {
    if (sqliteFiles.some(f => existsSync(join(dir, f)))) {
      found.add('sqlite');
    }
  }

  return Array.from(found);
}

function detectProjectType(workDir: string): ProjectInfo {
  const pm = detectPackageManager(workDir);
  const result: ProjectInfo = {
    workDir,
    hasBackend: false,
    hasFrontend: false,
    backendType: 'unknown',
    backendDir: workDir,
    frontendType: 'unknown',
    frontendDir: join(workDir, 'frontend'),
    hasDocker: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile']
      .some(f => existsSync(join(workDir, f))),
    databases: [],
    pm,
    isMonorepo: false
  };

  // Search for backend in common locations
  const backendSearchDirs = [
    workDir,
    join(workDir, 'backend'),
    join(workDir, 'server'),
    join(workDir, 'api'),
    join(workDir, 'src')
  ];

  // Also check monorepo packages
  const packagesDir = join(workDir, 'packages');
  if (existsSync(packagesDir)) {
    try {
      for (const pkg of readdirSync(packagesDir)) {
        backendSearchDirs.push(join(packagesDir, pkg));
      }
    } catch {}
  }

  for (const dir of backendSearchDirs) {
    if (!existsSync(dir)) continue;
    const detected = detectBackend(dir);
    if (detected.found) {
      result.hasBackend = true;
      result.backendType = detected.type;
      result.backendDir = dir;
      break;
    }
  }

  // Detect monorepo: backend is in a subdirectory and root has workspace config
  if (result.backendDir !== workDir) {
    const rootPkg = safeReadJson(join(workDir, 'package.json'));
    result.isMonorepo = !!(
      existsSync(join(workDir, 'pnpm-workspace.yaml')) ||
      rootPkg?.workspaces ||
      existsSync(join(workDir, 'turbo.json')) ||
      existsSync(join(workDir, 'lerna.json')) ||
      existsSync(join(workDir, 'nx.json'))
    );
  }

  // Search for frontend
  const frontendSearchDirs = ['frontend', 'client', 'web', 'app', 'ui'];
  for (const dir of frontendSearchDirs) {
    const fullDir = join(workDir, dir);
    if (!existsSync(fullDir)) continue;
    const fe = detectFrontend(fullDir);
    if (fe.found) {
      result.hasFrontend = true;
      result.frontendType = fe.type;
      result.frontendDir = fullDir;
      break;
    }
  }

  // Check root level if no frontend subdir found (and root isn't the backend)
  if (!result.hasFrontend && result.backendDir !== workDir) {
    const fe = detectFrontend(workDir);
    if (fe.found) {
      result.hasFrontend = true;
      result.frontendType = fe.type;
      result.frontendDir = workDir;
    }
  }

  // Detect databases
  result.databases = detectDatabases(workDir, result.backendDir);

  return result;
}

// ═══════════════════════════════════════════
// Prerequisite installation
// ═══════════════════════════════════════════

/** Check if a binary is on PATH */
function hasCommand(binary: string): boolean {
  return runCommand(`which ${binary}`, '/tmp', 3000).success;
}

/** Install commands per backend type — only what's needed beyond base system */
const INSTALL_RECIPES: Record<BackendType, Array<{ check: string; install: string; label: string }>> = {
  node: [
    { check: 'node', install: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs', label: 'Node.js' }
  ],
  go: [
    { check: 'go', install: 'curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -C /usr/local -xzf - && ln -sf /usr/local/go/bin/go /usr/local/bin/go', label: 'Go' }
  ],
  ruby: [
    { check: 'ruby', install: 'apt-get install -y ruby-full', label: 'Ruby' },
    { check: 'bundle', install: 'gem install bundler', label: 'Bundler' }
  ],
  python: [
    { check: 'python3', install: 'apt-get install -y python3 python3-pip python3-venv', label: 'Python 3' }
  ],
  dotnet: [
    { check: 'dotnet', install: 'apt-get install -y dotnet-sdk-8.0 || (wget https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh && chmod +x /tmp/dotnet-install.sh && /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/local/share/dotnet && ln -sf /usr/local/share/dotnet/dotnet /usr/local/bin/dotnet)', label: '.NET SDK' }
  ],
  php: [
    { check: 'php', install: 'apt-get install -y php-cli php-xml php-mbstring php-curl php-zip', label: 'PHP' },
    { check: 'composer', install: 'curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer', label: 'Composer' }
  ],
  rust: [
    { check: 'cargo', install: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env" && ln -sf "$HOME/.cargo/bin/cargo" /usr/local/bin/cargo && ln -sf "$HOME/.cargo/bin/rustc" /usr/local/bin/rustc', label: 'Rust' }
  ],
  spring: [
    { check: 'java', install: 'apt-get install -y default-jdk', label: 'Java JDK' }
  ],
  elixir: [
    { check: 'elixir', install: 'apt-get install -y erlang elixir', label: 'Elixir' }
  ],
  unknown: []
};

/**
 * Auto-install missing prerequisites for the detected stack.
 * Runs apt-get update once if any apt packages are needed.
 */
function installPrerequisites(project: ProjectInfo): CheckResult {
  const start = Date.now();
  const installed: string[] = [];
  const failed: string[] = [];
  let aptUpdated = false;

  /** Run apt-get update once before first apt install */
  function ensureAptUpdated(): void {
    if (aptUpdated) return;
    runCommand('apt-get update -qq', '/tmp', 30000);
    aptUpdated = true;
  }

  // Git (always needed)
  if (!hasCommand('git')) {
    ensureAptUpdated();
    const r = runCommand('apt-get install -y git', '/tmp', 60000);
    (r.success ? installed : failed).push('git');
  }

  // Docker (if compose file exists)
  if (project.hasDocker) {
    if (!hasCommand('docker')) {
      ensureAptUpdated();
      const r = runCommand(
        'apt-get install -y ca-certificates curl && install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && apt-get update -qq && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin',
        '/tmp', 120000
      );
      (r.success ? installed : failed).push('Docker');
    } else {
      // Docker installed but daemon may not be running
      if (!runCommand('docker info', '/tmp', 5000).success) {
        runCommand('systemctl start docker || service docker start', '/tmp', 10000);
      }
    }
  }

  // Backend prerequisites
  if (project.hasBackend) {
    const recipes = INSTALL_RECIPES[project.backendType] || [];
    for (const recipe of recipes) {
      if (hasCommand(recipe.check)) continue;
      console.log(`[quick-check] Installing ${recipe.label}...`);
      if (recipe.install.includes('apt-get install')) ensureAptUpdated();
      const r = runCommand(recipe.install, '/tmp', 180000);
      (r.success ? installed : failed).push(recipe.label);
    }
  }

  // Frontend (needs Node/npm for any JS-based frontend)
  if (project.hasFrontend) {
    if (!hasCommand('node')) {
      console.log('[quick-check] Installing Node.js for frontend...');
      ensureAptUpdated();
      const r = runCommand('curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs', '/tmp', 120000);
      (r.success ? installed : failed).push('Node.js (frontend)');
    }
  }

  // Package manager (if project needs pnpm/yarn/bun and it's not installed)
  if (project.pm !== 'npm' && !hasCommand(project.pm)) {
    const pmInstallCmds: Record<string, { cmd: string; label: string }> = {
      pnpm: { cmd: 'npm install -g pnpm', label: 'pnpm' },
      yarn: { cmd: 'npm install -g yarn', label: 'Yarn' },
      bun:  { cmd: 'npm install -g bun || (curl -fsSL https://bun.sh/install | bash)', label: 'Bun' }
    };
    const pmRecipe = pmInstallCmds[project.pm];
    if (pmRecipe) {
      console.log(`[quick-check] Installing ${pmRecipe.label}...`);
      const r = runCommand(pmRecipe.cmd, '/tmp', 60000);
      (r.success ? installed : failed).push(pmRecipe.label);
    }
  }

  if (failed.length > 0) {
    return {
      name: 'Prerequisites',
      passed: false,
      message: `Failed to install: ${failed.join(', ')}${installed.length > 0 ? `. Installed: ${installed.join(', ')}` : ''}`,
      duration: Date.now() - start
    };
  }

  return {
    name: 'Prerequisites',
    passed: true,
    message: installed.length > 0
      ? `Installed: ${installed.join(', ')}`
      : 'All required tools already available',
    duration: Date.now() - start
  };
}

// ═══════════════════════════════════════════
// Check: Docker services
// ═══════════════════════════════════════════

async function checkDockerServices(workDir: string): Promise<CheckResult> {
  const start = Date.now();
  const hasCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .some(f => existsSync(join(workDir, f)));

  if (!hasCompose) {
    return { name: 'Docker Services', passed: true, message: 'No compose file found', duration: Date.now() - start };
  }

  const compose = getComposeCommand(workDir);

  const upResult = runCommand(`${compose} up -d`, workDir, 60000);
  if (!upResult.success) {
    return {
      name: 'Docker Services', passed: false,
      message: `${compose} up failed: ${upResult.output.slice(0, 200)}`,
      duration: Date.now() - start
    };
  }

  // Wait for services to stabilize
  await new Promise(r => setTimeout(r, 3000));

  const psResult = runCommand(`${compose} ps --services --filter "status=running"`, workDir, 10000);
  return {
    name: 'Docker Services',
    passed: psResult.success && psResult.output.trim().length > 0,
    message: psResult.success ? `Services running: ${psResult.output.trim().replace(/\n/g, ', ')}` : 'No services running',
    duration: Date.now() - start
  };
}

// ═══════════════════════════════════════════
// Check: Databases (stack-agnostic)
// ═══════════════════════════════════════════

/**
 * Find Docker container name for a given DB type from running containers
 */
function findDbContainer(dbType: DatabaseType): string | null {
  const dbInfo = DATABASE_INFO.find(d => d.type === dbType);
  if (!dbInfo) return null;
  try {
    const ps = execSync('docker ps --format "{{.Names}}\\t{{.Image}}"', {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    for (const line of ps.trim().split('\n').filter(Boolean)) {
      const [name, image] = line.split('\t');
      if (dbInfo.imagePattern.test(image || '')) return name;
    }
  } catch {}
  return null;
}

function checkDatabase(workDir: string, dbType: DatabaseType, backendDir: string): CheckResult {
  const start = Date.now();
  const dbInfo = DATABASE_INFO.find(d => d.type === dbType);
  const label = dbType.charAt(0).toUpperCase() + dbType.slice(1);

  // SQLite: just verify the file exists or can be created
  if (dbType === 'sqlite') {
    const sqliteFiles = ['db.sqlite3', 'database.sqlite', 'data.db', 'app.db', 'dev.db'];
    for (const dir of [workDir, backendDir]) {
      if (sqliteFiles.some(f => existsSync(join(dir, f)))) {
        return { name: 'SQLite Database', passed: true, message: 'SQLite database file found', duration: Date.now() - start };
      }
    }
    return { name: 'SQLite Database', passed: true, message: 'SQLite detected (file will be created on first run)', duration: Date.now() - start };
  }

  if (!dbInfo) {
    return { name: `${label} Connection`, passed: false, message: `Unknown database type: ${dbType}`, duration: Date.now() - start };
  }

  // 1. Try docker exec readiness check
  const containerName = findDbContainer(dbType);
  if (containerName) {
    for (const cmd of dbInfo.dockerReadiness) {
      const result = runCommand(`docker exec ${containerName} ${cmd}`, workDir, 10000);
      if (result.success) {
        return {
          name: `${label} Connection`, passed: true,
          message: `${label} accepting connections (container: ${containerName})`,
          duration: Date.now() - start
        };
      }
    }
  }

  // 2. Try local readiness tools
  for (const cmd of dbInfo.localReadiness) {
    const result = runCommand(cmd, workDir, 5000);
    if (result.success) {
      return {
        name: `${label} Connection`, passed: true,
        message: `${label} accepting connections (local)`,
        duration: Date.now() - start
      };
    }
  }

  // 3. Try connection string + Node driver from backendDir
  const envContent = readEnvFiles(workDir, backendDir);
  const connMatch = envContent.match(dbInfo.connectionStringPattern);
  const connString = connMatch ? connMatch[1].trim() : '';

  if (connString) {
    // Try Node driver if available in project
    const dirsToTry = backendDir !== workDir ? [backendDir, workDir] : [workDir];
    for (const dir of dirsToTry) {
      if (existsSync(join(dir, 'node_modules', dbInfo.nodeDriver))) {
        const testScript = buildNodeConnectionTest(dbType, connString);
        if (testScript) {
          const nodeResult = runCommand(`node -e "${testScript}"`, dir, 10000);
          if (nodeResult.success) {
            return {
              name: `${label} Connection`, passed: true,
              message: `${label} connected via Node.js driver`,
              duration: Date.now() - start
            };
          }
        }
      }
    }

    // 4. Raw TCP to the port
    const portMatch = connString.match(/:(\d+)/);
    const hostMatch = connString.match(/@([^:/?]+)/) || connString.match(/:\/\/([^:/?]+)/);
    if (portMatch && hostMatch) {
      const tcpResult = runCommand(
        `node -e "require('net').createConnection(${portMatch[1]},'${hostMatch[1]}',()=>{console.log('OK');process.exit(0)}).on('error',()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))"`,
        workDir, 5000
      );
      return {
        name: `${label} Connection`,
        passed: tcpResult.success,
        message: tcpResult.success
          ? `${label} port ${portMatch[1]} is open`
          : `Cannot connect to ${label} at ${hostMatch[1]}:${portMatch[1]}`,
        duration: Date.now() - start
      };
    }
  }

  // If we found a container but readiness failed, it might be starting up
  if (containerName) {
    return {
      name: `${label} Connection`, passed: false,
      message: `${label} container '${containerName}' found but not responding to readiness check`,
      duration: Date.now() - start
    };
  }

  return {
    name: `${label} Connection`, passed: false,
    message: `No ${label} instance found (no container, no local service, no connection string)`,
    duration: Date.now() - start
  };
}

/** Build a minimal Node.js connection test script for a given DB type */
function buildNodeConnectionTest(dbType: DatabaseType, connString: string): string | null {
  // Escape single quotes in connection string
  const safe = connString.replace(/'/g, "\\'");
  switch (dbType) {
    case 'postgres':
      return `const{Client}=require('pg');new Client({connectionString:'${safe}'}).connect().then(()=>{console.log('OK');process.exit(0)}).catch(()=>process.exit(1))`;
    case 'mysql':
      return `const m=require('mysql2');const c=m.createConnection('${safe}');c.connect(e=>{if(e)process.exit(1);console.log('OK');process.exit(0)})`;
    case 'mongodb':
      return `const{MongoClient}=require('mongodb');MongoClient.connect('${safe}').then(()=>{console.log('OK');process.exit(0)}).catch(()=>process.exit(1))`;
    case 'redis':
      return `const{createClient}=require('redis');const c=createClient({url:'${safe}'});c.connect().then(()=>{console.log('OK');process.exit(0)}).catch(()=>process.exit(1))`;
    default:
      return null;
  }
}

// ═══════════════════════════════════════════
// Check: Backend build
// ═══════════════════════════════════════════

function checkBackendBuild(project: ProjectInfo): CheckResult {
  const { backendDir, backendType, pm, isMonorepo, workDir } = project;
  const start = Date.now();
  const config = BUILD_CONFIG[backendType];

  if (!config || config.buildCmds.length === 0) {
    return {
      name: 'Backend Build', passed: true,
      message: `No build check configured for ${backendType}`,
      duration: Date.now() - start
    };
  }

  // Auto-install dependencies if needed
  if (backendType === 'node') {
    // For Node/monorepo: install from workspace root with the right package manager
    const installDir = isMonorepo ? workDir : backendDir;
    if (!existsSync(join(backendDir, 'node_modules'))) {
      const installCmd = pmInstall(pm);
      console.log(`[quick-check] Running ${installCmd} in ${installDir}...`);
      const installResult = runCommand(installCmd, installDir, 120000);
      if (!installResult.success) {
        return {
          name: 'Backend Install', passed: false,
          message: `${installCmd} failed: ${installResult.output.slice(0, 200)}`,
          duration: Date.now() - start
        };
      }
    }
  } else if (config.installCmd) {
    const needsInstall =
      (backendType === 'ruby' && !existsSync(join(backendDir, 'vendor')) && !runCommand('bundle check', backendDir, 5000).success) ||
      (backendType === 'dotnet' && !existsSync(join(backendDir, 'obj'))) ||
      (backendType === 'php' && !existsSync(join(backendDir, 'vendor'))) ||
      (backendType === 'elixir' && !existsSync(join(backendDir, 'deps')));

    if (needsInstall) {
      const installResult = runCommand(config.installCmd, backendDir, 120000);
      if (!installResult.success) {
        return {
          name: 'Backend Install', passed: false,
          message: `${config.installCmd} failed: ${installResult.output.slice(0, 200)}`,
          duration: Date.now() - start
        };
      }
    }
  }

  // Try build commands — substitute package manager for Node.js
  for (const buildCmd of config.buildCmds) {
    if (buildCmd.condition && !existsSync(join(backendDir, buildCmd.condition))) continue;

    let cmd = buildCmd.cmd;
    if (backendType === 'node') {
      // Replace npm/npx with correct package manager
      cmd = cmd.replace(/^npx /, pmExec(pm, '').trim() + ' ')
               .replace(/^npm run /, pmRun(pm, '').trim() + ' ');
    }

    const result = runCommand(cmd, backendDir, config.timeoutMs);
    return {
      name: `Backend Build (${buildCmd.label})`,
      passed: result.success,
      message: result.success
        ? `${buildCmd.label} successful`
        : `${buildCmd.label} failed: ${result.output.slice(-500)}`,
      duration: Date.now() - start
    };
  }

  return {
    name: 'Backend Build', passed: true,
    message: 'No applicable build command found (skipped)',
    duration: Date.now() - start
  };
}

// ═══════════════════════════════════════════
// Check: Backend starts
// ═══════════════════════════════════════════

/** Extract port from process stdout (e.g. "listening on port 3001", "running on :3001") */
function extractPortFromOutput(output: string): number | null {
  // Common patterns: "port 3001", "on :3001", "listening on 3001", "localhost:3001"
  const patterns = [
    /(?:port|PORT)\s+(\d{2,5})/,
    /(?:listening|running|started|available|serving)\s+(?:on|at)\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:?(\d{2,5})/i,
    /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/,
    /on\s+port\s+(\d{2,5})/i,
  ];
  for (const pat of patterns) {
    const m = output.match(pat);
    if (m) {
      const p = parseInt(m[1]);
      if (p >= 80 && p <= 65535) return p;
    }
  }
  return null;
}

function detectPort(backendDir: string, backendType: BackendType): number {
  const config = START_CONFIG[backendType];
  const defaultPort = config?.defaultPort || 3000;

  // Check .env for PORT or common variants (PORT, API_PORT, SERVER_PORT, APP_PORT)
  const envContent = safeRead(join(backendDir, '.env'));
  const portEnv = envContent.match(/^(?:PORT|API_PORT|SERVER_PORT|APP_PORT)\s*=\s*(\d+)/m);
  if (portEnv) return parseInt(portEnv[1]);

  // Check package.json scripts for port references (Node.js)
  if (backendType === 'node') {
    const pkg = safeReadJson(join(backendDir, 'package.json'));
    if (pkg?.scripts) {
      const scripts = JSON.stringify(pkg.scripts);
      const portMatch = scripts.match(/PORT[=: ]+(\d+)/);
      if (portMatch) return parseInt(portMatch[1]);
    }
  }

  // Check .NET launchSettings.json
  if (backendType === 'dotnet') {
    const launchSettings = safeReadJson(join(backendDir, 'Properties', 'launchSettings.json'));
    if (launchSettings?.profiles) {
      for (const profile of Object.values(launchSettings.profiles) as any[]) {
        const url = profile?.applicationUrl || '';
        const portMatch = url.match(/:(\d+)/);
        if (portMatch) return parseInt(portMatch[1]);
      }
    }
  }

  // Check Spring application.properties/yml
  if (backendType === 'spring') {
    const props = safeRead(join(backendDir, 'src', 'main', 'resources', 'application.properties'));
    const portMatch = props.match(/server\.port\s*=\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
  }

  // Check Elixir config
  if (backendType === 'elixir') {
    const config = safeRead(join(backendDir, 'config', 'dev.exs'));
    const portMatch = config.match(/port:\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
  }

  return defaultPort;
}

async function checkBackendStarts(project: ProjectInfo): Promise<CheckResult> {
  const { workDir, backendDir, backendType, pm } = project;
  const start = Date.now();
  const config = START_CONFIG[backendType];

  if (!config || config.startCmds.length === 0) {
    return {
      name: 'Backend Starts', passed: true,
      message: `No start check configured for ${backendType}`,
      duration: Date.now() - start
    };
  }

  let port = detectPort(backendDir, backendType);

  // If port is already in use (e.g. Docker is running the backend), just verify it responds
  if (await checkPort(port)) {
    const healthOk = await tryHealthCheck(port, config.healthPaths);
    return {
      name: 'Backend Starts', passed: true,
      message: healthOk
        ? `Port ${port} already active, health check passed`
        : `Port ${port} already active (backend running via Docker or external process)`,
      duration: Date.now() - start
    };
  }

  // Load .env files so the backend gets DATABASE_URL, etc.
  const projectEnv = loadEnvFiles(
    join(workDir, '.env'),
    join(workDir, '.env.local'),
    join(backendDir, '.env'),
    join(backendDir, '.env.local')
  );

  // Find applicable start command
  let startCmd = '';
  for (const sc of config.startCmds) {
    if (sc.condition && !existsSync(join(backendDir, sc.condition))) continue;

    // For Node.js, check package.json scripts and use correct package manager
    if (backendType === 'node' && sc.cmd.startsWith('npm')) {
      const pkg = safeReadJson(join(backendDir, 'package.json'));
      const scriptName = sc.cmd.replace('npm run ', '').replace('npm ', '');
      if (scriptName === 'start' && !pkg?.scripts?.start) continue;
      if (scriptName === 'dev' && !pkg?.scripts?.dev) continue;
      // Translate npm -> detected pm
      startCmd = scriptName === 'start' ? `${pm} start` : pmRun(pm, scriptName);
      break;
    }

    startCmd = sc.cmd;
    break;
  }

  if (!startCmd) {
    return {
      name: 'Backend Starts', passed: true,
      message: `Could not determine start command for ${backendType} (skipped)`,
      duration: Date.now() - start
    };
  }

  // Start the process with project env vars
  // The readyCheck also parses stdout for port announcements (e.g. "running on port 3001")
  // so we detect the actual port even if it differs from the expected one
  let actualPort = port;
  const result = await startProcess(startCmd, backendDir, async (output) => {
    // Check the expected port first
    if (await checkPort(actualPort)) return true;

    // Parse stdout for a port announcement that differs from expected
    const outputPort = extractPortFromOutput(output);
    if (outputPort && outputPort !== actualPort) {
      actualPort = outputPort;
      return checkPort(actualPort);
    }

    return false;
  }, 20000, projectEnv);

  if (!result.handle) {
    const snippet = result.output ? result.output.slice(-300) : 'no output captured';
    return {
      name: 'Backend Starts', passed: false,
      message: `Backend failed to start (${result.reason}) on port ${actualPort} within 20s (cmd: ${startCmd})\nOutput: ${snippet}`,
      duration: Date.now() - start
    };
  }

  // Try health check on the actual port (may have changed via stdout detection)
  const healthOk = await tryHealthCheck(actualPort, config.healthPaths);

  // Clean up
  result.handle.kill();

  return {
    name: 'Backend Starts', passed: true,
    message: healthOk
      ? `Backend started on port ${actualPort}, health check passed`
      : `Backend started on port ${actualPort} (no health endpoint responded)`,
    duration: Date.now() - start
  };
}

/** Try multiple health check paths, return true if any responds 2xx/3xx */
async function tryHealthCheck(port: number, paths: string[]): Promise<boolean> {
  const http = require('http');
  for (const path of paths) {
    try {
      const ok: boolean = await new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}${path}`, (res: any) => {
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch {}
  }
  return false;
}

// ═══════════════════════════════════════════
// Check: Frontend build
// ═══════════════════════════════════════════

function checkFrontendBuild(project: ProjectInfo): CheckResult {
  const { frontendDir, pm, isMonorepo, workDir } = project;
  const start = Date.now();

  if (!existsSync(frontendDir) || !existsSync(join(frontendDir, 'package.json'))) {
    return {
      name: 'Frontend Build', passed: true,
      message: 'No frontend package.json found (skipped)',
      duration: Date.now() - start
    };
  }

  // Install if needed — monorepo installs from root
  if (!existsSync(join(frontendDir, 'node_modules'))) {
    const installDir = isMonorepo ? workDir : frontendDir;
    const installCmd = pmInstall(pm);
    const installResult = runCommand(installCmd, installDir, 120000);
    if (!installResult.success) {
      return {
        name: 'Frontend Install', passed: false,
        message: `${installCmd} failed: ${installResult.output.slice(0, 200)}`,
        duration: Date.now() - start
      };
    }
  }

  // Build
  const buildCmd = pmRun(pm, 'build');
  const result = runCommand(buildCmd, frontendDir, 120000);
  return {
    name: 'Frontend Build',
    passed: result.success,
    message: result.success ? 'Frontend builds successfully' : `Build failed: ${result.output.slice(0, 200)}`,
    duration: Date.now() - start
  };
}

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

export async function runQuickChecks(workDir: string): Promise<QuickCheckResult> {
  const startTime = Date.now();
  const checks: CheckResult[] = [];

  console.log('[quick-check] Detecting project stack...');
  const project = detectProjectType(workDir);
  console.log(`[quick-check] Detected: backend=${project.backendType} (${project.backendDir}), frontend=${project.frontendType}, docker=${project.hasDocker}, databases=[${project.databases.join(',')}], pm=${project.pm}, monorepo=${project.isMonorepo}`);

  // 0. Install missing prerequisites
  console.log('[quick-check] Checking prerequisites...');
  const prereqCheck = installPrerequisites(project);
  checks.push(prereqCheck);
  if (!prereqCheck.passed) {
    return { passed: false, checks, duration: Date.now() - startTime };
  }
  if (prereqCheck.message !== 'All required tools already available') {
    console.log(`[quick-check] ${prereqCheck.message}`);
  }

  // 1. Docker services (starts DB containers, etc.)
  if (project.hasDocker) {
    console.log('[quick-check] Starting Docker services...');
    checks.push(await checkDockerServices(workDir));
    if (!checks[checks.length - 1].passed) {
      return { passed: false, checks, duration: Date.now() - startTime };
    }
    // Re-detect databases after Docker is up
    project.databases = detectDatabases(workDir, project.backendDir);
  }

  // 2. Database connections (all detected databases)
  if (project.databases.length > 0) {
    for (const db of project.databases) {
      console.log(`[quick-check] Checking ${db} connection...`);
      const dbCheck = checkDatabase(workDir, db, project.backendDir);
      checks.push(dbCheck);
      // DB failure is fatal only if it's a primary DB (not Redis)
      if (!dbCheck.passed && db !== 'redis') {
        console.log(`[quick-check] ${db} check failed — stopping early`);
        return { passed: false, checks, duration: Date.now() - startTime };
      }
    }
  }

  // 3. Backend build
  if (project.hasBackend) {
    console.log(`[quick-check] Checking ${project.backendType} backend build...`);
    checks.push(checkBackendBuild(project));
    if (!checks[checks.length - 1].passed) {
      return { passed: false, checks, duration: Date.now() - startTime };
    }

    // 4. Backend starts and responds
    console.log('[quick-check] Checking backend starts...');
    checks.push(await checkBackendStarts(project));
    if (!checks[checks.length - 1].passed) {
      return { passed: false, checks, duration: Date.now() - startTime };
    }
  }

  // 5. Frontend build
  if (project.hasFrontend) {
    console.log(`[quick-check] Checking ${project.frontendType} frontend build...`);
    checks.push(checkFrontendBuild(project));
    if (!checks[checks.length - 1].passed) {
      return { passed: false, checks, duration: Date.now() - startTime };
    }
  }

  const allPassed = checks.every(c => c.passed);
  return { passed: allPassed, checks, duration: Date.now() - startTime };
}

/**
 * Run quick check for a specific infrastructure ticket
 */
export async function runTicketVerification(
  workDir: string,
  ticketKey: string,
  ticketSummary: string
): Promise<CheckResult | null> {
  const project = detectProjectType(workDir);
  const summaryLower = ticketSummary.toLowerCase();

  // Database tickets
  const dbKeywords: Array<{ keywords: string[]; types: DatabaseType[] }> = [
    { keywords: ['postgres', 'psql', 'pg_'], types: ['postgres'] },
    { keywords: ['mysql', 'mariadb'], types: ['mysql'] },
    { keywords: ['mongo', 'mongodb'], types: ['mongodb'] },
    { keywords: ['redis'], types: ['redis'] },
    { keywords: ['database', 'schema', 'migration', 'db setup'], types: project.databases.length > 0 ? project.databases : ['postgres'] }
  ];

  for (const { keywords, types } of dbKeywords) {
    if (keywords.some(k => summaryLower.includes(k))) {
      console.log(`[ticket-verify] ${ticketKey}: Verifying database setup...`);
      // Check first matching type
      return checkDatabase(workDir, types[0], project.backendDir);
    }
  }

  // Backend tickets
  const backendKeywords = ['backend', 'server', 'api setup', 'express', 'fastapi', 'django', 'rails', 'spring', 'gin', 'actix', 'dotnet', 'laravel', 'phoenix'];
  if (backendKeywords.some(k => summaryLower.includes(k))) {
    console.log(`[ticket-verify] ${ticketKey}: Verifying backend builds...`);
    return checkBackendBuild(project);
  }

  // Frontend tickets
  const frontendKeywords = ['frontend', 'react', 'vue', 'angular', 'svelte', 'solid', 'vite', 'next.js', 'nuxt', 'ui setup', 'web app'];
  if (frontendKeywords.some(k => summaryLower.includes(k))) {
    console.log(`[ticket-verify] ${ticketKey}: Verifying frontend builds...`);
    return checkFrontendBuild(project);
  }

  // Auth/security tickets — verify backend still compiles
  if (summaryLower.includes('auth') || summaryLower.includes('jwt') || summaryLower.includes('login') || summaryLower.includes('oauth') || summaryLower.includes('session')) {
    console.log(`[ticket-verify] ${ticketKey}: Verifying backend still builds after auth changes...`);
    return checkBackendBuild(project);
  }

  // Docker/infrastructure tickets
  if (summaryLower.includes('docker') || summaryLower.includes('container') || summaryLower.includes('deploy') || summaryLower.includes('infrastructure')) {
    console.log(`[ticket-verify] ${ticketKey}: Verifying Docker services...`);
    return await checkDockerServices(workDir);
  }

  return null;
}
