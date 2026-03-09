/**
 * turkeycode run-local — Generate docker-compose.yml and run the app locally
 * 
 * Mirrors the production turkeycode.ai hosting environment.
 * Generates a Dockerfile (if missing) + docker-compose.yml based on detection.
 */

import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import type { ProjectDetection, Features, Runtime, Stack } from './detect';

const COMPOSE_FILE = 'docker-compose.turkeycode.yml';

interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile: string };
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: string[];
  restart?: string;
  command?: string;
  healthcheck?: {
    test: string;
    interval: string;
    timeout: string;
    retries: number;
  };
}

interface ComposeFile {
  version: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, object>;
}

function generateDockerfile(detection: ProjectDetection, cwd: string): string {
  const { runtime, stack, scripts } = detection;

  switch (runtime) {
    case 'node': {
      const nodeVersion = detection.runtimeVersion || '20';
      const installCmd = existsSync(join(cwd, 'yarn.lock')) ? 'yarn install --frozen-lockfile' :
                         existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'corepack enable && pnpm install --frozen-lockfile' :
                         'npm ci';
      const buildCmd = scripts.build ? 'RUN npm run build' : '';
      // Smart start command based on stack
      let startCmd = scripts.start || 'npm start';
      if (!scripts.start) {
        if (stack === 'vite' || (scripts.build && scripts.build.includes('vite'))) {
          startCmd = 'npx vite preview --host 0.0.0.0 --port 3000';
        } else if (stack === 'nextjs') {
          startCmd = 'npm start';
        }
      }

      return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY package*.json yarn.lock* pnpm-lock.yaml* ./
RUN ${installCmd}
COPY . .
${buildCmd}
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "${startCmd}"]
`;
    }

    case 'python': {
      const hasRequirements = existsSync(join(cwd, 'requirements.txt'));
      const hasPyproject = existsSync(join(cwd, 'pyproject.toml'));
      const installCmd = hasRequirements ? 'pip install -r requirements.txt' :
                         hasPyproject ? 'pip install .' : 'pip install .';
      const startCmd = scripts.start || (
        stack === 'django' ? 'gunicorn config.wsgi:application --bind 0.0.0.0:3000' :
        stack === 'flask' ? 'gunicorn app:app --bind 0.0.0.0:3000' :
        stack === 'fastapi' ? 'uvicorn main:app --host 0.0.0.0 --port 3000' :
        'python main.py'
      );

      return `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* ./
RUN ${installCmd}
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "${startCmd}"]
`;
    }

    case 'go': {
      const startCmd = scripts.start || './app';
      return `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o app .

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/app .
ENV PORT=3000
EXPOSE 3000
CMD ["${startCmd}"]
`;
    }

    case 'rust': {
      return `FROM rust:1.77-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/target/release/* ./
ENV PORT=3000
EXPOSE 3000
CMD ["./app"]
`;
    }

    case 'ruby': {
      const startCmd = scripts.start || (
        stack === 'rails' ? 'bundle exec rails server -b 0.0.0.0 -p 3000' :
        'bundle exec ruby app.rb -p 3000'
      );
      return `FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "${startCmd}"]
`;
    }

    case 'php': {
      return `FROM php:8.3-apache
WORKDIR /var/www/html
COPY . .
RUN if [ -f composer.json ]; then curl -sS https://getcomposer.org/installer | php && php composer.phar install; fi
EXPOSE 80
`;
    }

    case 'static': {
      return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
    }

    default:
      return `FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
`;
  }
}

function buildCompose(detection: ProjectDetection, cwd: string): ComposeFile {
  const { features, stack } = detection;
  const appName = detection.name.replace(/[^a-z0-9-]/g, '-');

  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, object> = {};

  // App service
  const appEnv: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '3000',
  };
  const dependsOn: string[] = [];

  // Database
  if (features.database === 'postgres') {
    services.postgres = {
      image: 'postgres:16-alpine',
      ports: ['5432:5432'],
      environment: {
        POSTGRES_USER: appName,
        POSTGRES_PASSWORD: `${appName}_dev`,
        POSTGRES_DB: appName,
      },
      volumes: [`pg_data:/var/lib/postgresql/data`],
      restart: 'unless-stopped',
      healthcheck: {
        test: 'pg_isready -U ' + appName,
        interval: '5s',
        timeout: '5s',
        retries: 5,
      },
    };
    volumes.pg_data = {};
    appEnv.DATABASE_URL = `postgresql://${appName}:${appName}_dev@postgres:5432/${appName}`;
    dependsOn.push('postgres');
  } else if (features.database === 'mysql') {
    services.mysql = {
      image: 'mysql:8.0',
      ports: ['3306:3306'],
      environment: {
        MYSQL_ROOT_PASSWORD: `${appName}_root`,
        MYSQL_DATABASE: appName,
        MYSQL_USER: appName,
        MYSQL_PASSWORD: `${appName}_dev`,
      },
      volumes: ['mysql_data:/var/lib/mysql'],
      restart: 'unless-stopped',
    };
    volumes.mysql_data = {};
    appEnv.DATABASE_URL = `mysql://${appName}:${appName}_dev@mysql:3306/${appName}`;
    dependsOn.push('mysql');
  } else if (features.database === 'mongodb') {
    services.mongo = {
      image: 'mongo:7',
      ports: ['27017:27017'],
      volumes: ['mongo_data:/data/db'],
      restart: 'unless-stopped',
    };
    volumes.mongo_data = {};
    appEnv.MONGODB_URI = `mongodb://mongo:27017/${appName}`;
    dependsOn.push('mongo');
  }

  // Redis
  if (features.redis) {
    services.redis = {
      image: 'redis:7-alpine',
      ports: ['6379:6379'],
      restart: 'unless-stopped',
    };
    appEnv.REDIS_URL = 'redis://redis:6379';
    dependsOn.push('redis');
  }

  // Determine dockerfile
  const dockerfileName = existsSync(join(cwd, 'Dockerfile')) ? 'Dockerfile' : 'Dockerfile.turkeycode';

  // Generate Dockerfile if needed
  if (!existsSync(join(cwd, 'Dockerfile'))) {
    const dockerfile = generateDockerfile(detection, cwd);
    writeFileSync(join(cwd, 'Dockerfile.turkeycode'), dockerfile);
    console.log(`  Generated Dockerfile.turkeycode`);

    // Generate .dockerignore if not present
    if (!existsSync(join(cwd, '.dockerignore'))) {
      const dockerignore = [
        'node_modules',
        '.git',
        '.turkey',
        '*.log',
        'build.log',
        '.next/cache',
        '.env',
        '.env.local',
        '.env.*.local',
        'docker-compose*.yml',
        'Dockerfile.turkeycode',
      ].join('\n') + '\n';
      writeFileSync(join(cwd, '.dockerignore'), dockerignore);
      console.log(`  Generated .dockerignore`);
    }
  }

  // Load .env if it exists (don't override what we set)
  if (existsSync(join(cwd, '.env'))) {
    const envLines = readFileSync(join(cwd, '.env'), 'utf-8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        // Don't override DB/Redis URLs we generated
        if (!appEnv[key]) {
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          appEnv[key] = val;
        }
      }
    }
  }

  // Migration command
  let migrateCmd: string | undefined;
  if (detection.scripts.migrate) {
    migrateCmd = detection.scripts.migrate;
  } else if (features.database === 'postgres' && detection.runtime === 'node') {
    // Check for Prisma
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.['@prisma/client'] || pkg.devDependencies?.prisma) {
        migrateCmd = 'npx prisma db push';
      }
    } catch { /* ignore */ }
  }

  services.app = {
    build: { context: '.', dockerfile: dockerfileName },
    ports: ['3000:3000'],
    environment: appEnv,
    depends_on: dependsOn.length > 0 ? dependsOn : undefined,
    restart: 'unless-stopped',
  };

  return {
    version: '3.8',
    services,
    volumes: Object.keys(volumes).length > 0 ? volumes : undefined,
  };
}

function composeToYaml(compose: ComposeFile): string {
  // Simple YAML serializer — avoids adding js-yaml dependency
  let yaml = `# Generated by TurkeyCode 🦃\n# Mirrors your turkeycode.ai production environment\n# Edit freely — this file is yours\n\n`;
  yaml += `version: "${compose.version}"\n\nservices:\n`;

  for (const [name, svc] of Object.entries(compose.services)) {
    yaml += `  ${name}:\n`;
    if (svc.image) yaml += `    image: ${svc.image}\n`;
    if (svc.build) {
      yaml += `    build:\n`;
      yaml += `      context: ${svc.build.context}\n`;
      yaml += `      dockerfile: ${svc.build.dockerfile}\n`;
    }
    if (svc.ports) {
      yaml += `    ports:\n`;
      for (const p of svc.ports) yaml += `      - "${p}"\n`;
    }
    if (svc.environment) {
      yaml += `    environment:\n`;
      for (const [k, v] of Object.entries(svc.environment)) {
        yaml += `      ${k}: "${v}"\n`;
      }
    }
    if (svc.volumes) {
      yaml += `    volumes:\n`;
      for (const v of svc.volumes) yaml += `      - ${v}\n`;
    }
    if (svc.depends_on) {
      yaml += `    depends_on:\n`;
      for (const d of svc.depends_on) yaml += `      - ${d}\n`;
    }
    if (svc.restart) yaml += `    restart: ${svc.restart}\n`;
    if (svc.command) yaml += `    command: ${svc.command}\n`;
    if (svc.healthcheck) {
      yaml += `    healthcheck:\n`;
      yaml += `      test: ${svc.healthcheck.test}\n`;
      yaml += `      interval: ${svc.healthcheck.interval}\n`;
      yaml += `      timeout: ${svc.healthcheck.timeout}\n`;
      yaml += `      retries: ${svc.healthcheck.retries}\n`;
    }
    yaml += '\n';
  }

  if (compose.volumes) {
    yaml += `volumes:\n`;
    for (const name of Object.keys(compose.volumes)) {
      yaml += `  ${name}:\n`;
    }
  }

  return yaml;
}

export async function runLocal(cwd: string, detection: ProjectDetection): Promise<void> {
  const appName = detection.name.replace(/[^a-z0-9-]/g, '-');

  console.log('');
  console.log('Generating docker-compose...');

  const compose = buildCompose(detection, cwd);
  const yaml = composeToYaml(compose);

  const composePath = join(cwd, COMPOSE_FILE);
  writeFileSync(composePath, yaml);
  console.log(`  Written to ${COMPOSE_FILE}`);

  // Run migrations if needed
  const migrateCmd = detection.scripts.migrate;

  // List services
  const serviceNames = Object.keys(compose.services).filter(s => s !== 'app');
  if (serviceNames.length > 0) {
    console.log(`  Services: ${serviceNames.join(', ')}`);
  }

  console.log('');
  console.log('Starting...');

  // Check Docker is available
  try {
    execSync('docker compose version', { stdio: 'pipe' });
  } catch {
    try {
      execSync('docker-compose version', { stdio: 'pipe' });
    } catch {
      console.error('Docker Compose not found. Install Docker Desktop or docker-compose.');
      process.exit(1);
    }
  }

  // Build and start
  const composeCmd = 'docker compose';

  try {
    // Build
    console.log('  Building containers...');
    execSync(`${composeCmd} -f ${COMPOSE_FILE} -p ${appName} build`, {
      cwd,
      stdio: 'inherit',
    });

    // Start dependencies first if any
    if (serviceNames.length > 0) {
      console.log(`  Starting ${serviceNames.join(', ')}...`);
      execSync(`${composeCmd} -f ${COMPOSE_FILE} -p ${appName} up -d ${serviceNames.join(' ')}`, {
        cwd,
        stdio: 'inherit',
      });

      // Wait for health checks
      console.log('  Waiting for services...');
      await new Promise(r => setTimeout(r, 3000));
    }

    // Run migrations
    if (migrateCmd) {
      console.log(`  Running migrations: ${migrateCmd}`);
      try {
        execSync(`${composeCmd} -f ${COMPOSE_FILE} -p ${appName} run --rm app sh -c "${migrateCmd}"`, {
          cwd,
          stdio: 'inherit',
        });
      } catch {
        console.log('  ⚠️  Migration failed — app may still work');
      }
    }

    console.log('');
    console.log('  🦃 Starting app...');
    console.log(`  → http://localhost:3000`);
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    // Start app in foreground (streams logs)
    const child = spawn(composeCmd, ['-f', COMPOSE_FILE, '-p', appName, 'up', 'app'], {
      cwd,
      stdio: 'inherit',
      shell: true,
    });

    // Handle Ctrl+C gracefully
    const cleanup = () => {
      console.log('\n  Stopping...');
      try {
        execSync(`${composeCmd} -f ${COMPOSE_FILE} -p ${appName} down`, {
          cwd,
          stdio: 'inherit',
        });
      } catch { /* ignore */ }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    child.on('exit', (code) => {
      process.exit(code ?? 1);
    });

  } catch (err) {
    console.error(`Failed: ${(err as Error).message}`);
    // Cleanup on error
    try {
      execSync(`${composeCmd} -f ${COMPOSE_FILE} -p ${appName} down`, { cwd, stdio: 'pipe' });
    } catch { /* ignore */ }
    process.exit(1);
  }
}
