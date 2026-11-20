/**
 * Deploy to a droplet in the caller's own DigitalOcean account.
 *
 * One droplet per app. The project is tarred, copied over SSH and built on the
 * droplet with the same Dockerfile and Compose services `turkeycode run-local`
 * uses, plus Caddy in front on ports 80 and 443. Databases keep their data in
 * named volumes on the droplet and are never published to the internet.
 */

import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

import type { ProjectDetection } from './detect';
import { DigitalOcean, FIREWALL_NAME, dropletName, publicIp, type Droplet } from './digitalocean';
import { packageApp } from './package';
import {
  buildCompose,
  composeToYaml,
  resolveMigrateCmd,
  type ComposeFile,
  type ComposeService,
} from './run-local';

export const DROPLET_IMAGE = 'ubuntu-24-04-x64';
export const DEFAULT_REGION = 'nyc3';
const REMOTE_ROOT = '/opt/turkeycode';
const COMPOSE_NAME = 'docker-compose.turkeycode.yml';
const SSH_USER = 'root';

const STATE_DIR = join(homedir(), '.turkeycode');
const KEY_PATH = join(STATE_DIR, 'deploy_key');
const KNOWN_HOSTS = join(STATE_DIR, 'deploy_known_hosts');

// ============================================================================
// Pure builders
// ============================================================================

/** First boot: Docker with the Compose plugin, and swap so a 1 GB droplet can build. */
export function cloudInit(): string {
  return [
    '#cloud-config',
    'swap:',
    '  filename: /swapfile',
    '  size: 2G',
    '  maxsize: 2G',
    'runcmd:',
    '  - curl -fsSL https://get.docker.com | sh',
    '  - systemctl enable --now docker',
    '',
  ].join('\n');
}

/** The smallest droplet that can hold the app; a database or Redis gets 2 GB. */
export function defaultSize(detection: ProjectDetection): string {
  const { database, redis } = detection.features;
  const needsRoom = redis || (database !== false && database !== 'sqlite');
  return needsRoom ? 's-1vcpu-2gb' : 's-1vcpu-1gb';
}

/**
 * The port the app container listens on. A project's own Dockerfile says so
 * with EXPOSE; the Dockerfiles turkeycode generates listen on 80 for PHP and
 * static sites and on $PORT (3000) for everything else.
 */
export function resolveAppPort(detection: ProjectDetection, cwd: string): number {
  const dockerfile = join(cwd, 'Dockerfile');
  if (existsSync(dockerfile)) {
    const match = readFileSync(dockerfile, 'utf-8').match(/^EXPOSE\s+(\d+)/m);
    return match ? parseInt(match[1], 10) : 3000;
  }
  return detection.runtime === 'php' || detection.runtime === 'static' ? 80 : 3000;
}

export interface ProductionComposeOptions {
  appPort: number;
  /** Domain for HTTPS. Without one the app is served over plain HTTP on the IP. */
  domain?: string;
  /** Keys the caller's --env file sets; they win over generated values. */
  envKeys?: string[];
}

/**
 * Turn the run-local Compose file into the one that runs on the droplet:
 * nothing but Caddy is published, development passwords become a secret
 * generated on the droplet, and the caller's env file is attached.
 */
export function productionCompose(compose: ComposeFile, options: ProductionComposeOptions): ComposeFile {
  const services: Record<string, ComposeService> = {};
  const userKeys = new Set(options.envKeys ?? []);

  for (const [name, original] of Object.entries(compose.services)) {
    const svc: ComposeService = { ...original, environment: { ...(original.environment ?? {}) } };
    delete svc.ports;

    const env = svc.environment!;
    for (const key of ['POSTGRES_PASSWORD', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD']) {
      if (key in env) env[key] = '${DB_PASSWORD}';
    }

    if (name === 'app') {
      env.PORT = String(options.appPort);
      if (env.DATABASE_URL) {
        // postgresql://name:name_dev@postgres:5432/name → the generated secret
        env.DATABASE_URL = env.DATABASE_URL.replace(/^([a-z]+:\/\/[^:/@]+):[^@]*@/, '$1:${DB_PASSWORD}@');
      }
      for (const key of userKeys) delete env[key];
      svc.env_file = ['../app.env'];
    }

    if (Object.keys(env).length === 0) delete svc.environment;
    services[name] = svc;
  }

  services.caddy = {
    image: 'caddy:2-alpine',
    ports: ['80:80', '443:443'],
    volumes: ['caddy_data:/data'],
    depends_on: ['app'],
    restart: 'unless-stopped',
    command: `caddy reverse-proxy --from ${options.domain ?? ':80'} --to app:${options.appPort}`,
  };

  return {
    // Compose ignores `version` now and warns about it on every command.
    version: '',
    services,
    volumes: { ...(compose.volumes ?? {}), caddy_data: {} },
  };
}

/** Parse KEY=VALUE lines; blank lines and # comments are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    vars[key] = trimmed.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return vars;
}

/**
 * The env file Compose reads on the droplet. Values are single-quoted so
 * Compose takes them literally: a `$` in a secret is not treated as a variable.
 */
export function envFileContent(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}='${value.replace(/'/g, "\\'")}'\n`)
    .join('');
}

/** Quote a string for a POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function composeCommand(appName: string): string {
  return `docker compose --env-file ../secrets.env -f ${COMPOSE_NAME} -p ${appName}`;
}

export interface RemoteScriptInput {
  appName: string;
  /** Services to start and wait for before migrating (databases, Redis). */
  dependencies: string[];
  migrateCmd?: string;
}

/**
 * The script run on the droplet. It expects release.tar.gz, compose.yml and
 * app.env already copied into the app directory.
 */
export function remoteScript(input: RemoteScriptInput): string {
  const dir = `${REMOTE_ROOT}/${input.appName}`;
  const dc = composeCommand(input.appName);
  const lines = [
    'set -euo pipefail',
    '',
    '# First boot installs Docker; wait for it to finish.',
    'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi',
    'if ! docker compose version >/dev/null 2>&1; then',
    '  echo "Docker is not installed on this droplet. See /var/log/cloud-init-output.log" >&2',
    '  exit 1',
    'fi',
    '',
    `cd ${dir}`,
    '',
    '# Generated once and kept, so a redeploy still matches the database volume.',
    'if [ ! -f secrets.env ]; then',
    '  (umask 077; echo "DB_PASSWORD=$(openssl rand -hex 24)" > secrets.env)',
    'fi',
    'chmod 600 app.env',
    '',
    'rm -rf src.new',
    'mkdir src.new',
    'tar -xzf release.tar.gz -C src.new',
    `mv compose.yml src.new/${COMPOSE_NAME}`,
    'rm -rf src.old',
    'if [ -d src ]; then mv src src.old; fi',
    'mv src.new src',
    'rm -rf src.old release.tar.gz',
    'cd src',
    '',
    'echo "==> Building"',
    `${dc} build </dev/null`,
  ];

  if (input.dependencies.length > 0) {
    const deps = input.dependencies.join(' ');
    lines.push('', `echo "==> Starting ${deps}"`, `${dc} up -d --quiet-pull --wait ${deps} </dev/null || sleep 10`);
  }

  if (input.migrateCmd) {
    lines.push(
      '',
      'echo "==> Migrating"',
      // This script reaches bash on stdin. Without </dev/null the container
      // would read the rest of it and the app would never be started.
      `${dc} run --rm -T app sh -c ${shQuote(input.migrateCmd)} </dev/null || echo "WARNING: the migration failed; the app may still start"`
    );
  }

  lines.push(
    '',
    'echo "==> Starting the app"',
    `${dc} up -d --quiet-pull --remove-orphans </dev/null`,
    'docker image prune -f >/dev/null 2>&1 || true',
    ''
  );

  return lines.join('\n');
}

// ============================================================================
// SSH
// ============================================================================

/** The keypair turkeycode uses to reach droplets it creates. Made on first use. */
export function ensureDeployKey(): { privatePath: string; publicKey: string } {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(KEY_PATH)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'turkeycode-deploy', '-f', KEY_PATH], {
      stdio: 'pipe',
    });
    chmodSync(KEY_PATH, 0o600);
  }
  return { privatePath: KEY_PATH, publicKey: readFileSync(`${KEY_PATH}.pub`, 'utf-8').trim() };
}

function sshOptions(): string[] {
  return [
    '-i', KEY_PATH,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'LogLevel=ERROR',
  ];
}

/** DigitalOcean reuses addresses; drop any key remembered for a previous droplet. */
function forgetHost(ip: string): void {
  if (!existsSync(KNOWN_HOSTS)) return;
  spawnSync('ssh-keygen', ['-R', ip, '-f', KNOWN_HOSTS], { stdio: 'pipe' });
}

async function waitForSsh(ip: string, timeoutMs = 4 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  for (;;) {
    const res = spawnSync('ssh', [...sshOptions(), `${SSH_USER}@${ip}`, 'true'], { encoding: 'utf-8' });
    if (res.status === 0) return;
    lastError = (res.stderr || '').trim();
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not reach ${ip} over SSH with ${KEY_PATH}.\n` +
        (lastError ? `  ${lastError}\n` : '') +
        `  If this droplet was created from another machine, copy that machine's ` +
        `~/.turkeycode/deploy_key here or delete the droplet and deploy again.`
      );
    }
    await new Promise(r => setTimeout(r, 5_000));
  }
}

function sshRun(ip: string, command: string, options: { input?: string; capture?: boolean } = {}): string {
  const res = spawnSync('ssh', [...sshOptions(), `${SSH_USER}@${ip}`, command], {
    input: options.input,
    encoding: 'utf-8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', options.capture ? 'pipe' : 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Remote command failed (exit ${res.status}).`);
  return options.capture ? res.stdout : '';
}

function scp(ip: string, local: string, remote: string): void {
  const res = spawnSync('scp', [...sshOptions(), '-q', local, `${SSH_USER}@${ip}:${remote}`], { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Copying ${local} to the droplet failed (exit ${res.status}).`);
}

// ============================================================================
// Deploy
// ============================================================================

export interface DeployOptions {
  name?: string;
  domain?: string;
  region?: string;
  size?: string;
  envFile?: string;
  yes?: boolean;
}

export interface DeployResult {
  name: string;
  ip: string;
  url: string;
  created: boolean;
  live: boolean;
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function provision(
  api: DigitalOcean,
  name: string,
  detection: ProjectDetection,
  options: DeployOptions
): Promise<Droplet> {
  const region = options.region ?? DEFAULT_REGION;
  const sizeSlug = options.size ?? defaultSize(detection);

  const size = await api.getSize(sizeSlug);
  if (!size) throw new Error(`DigitalOcean has no droplet size "${sizeSlug}". See: doctl compute size list`);
  if (!size.available || !size.regions.includes(region)) {
    throw new Error(`Size ${sizeSlug} is not available in region ${region}. Pass --region or --size.`);
  }

  console.log('  No droplet for this app yet. This will create one in your DigitalOcean account:');
  console.log(`    Name:    ${name}`);
  console.log(`    Region:  ${region}`);
  console.log(`    Size:    ${sizeSlug} (${size.vcpus} vCPU, ${size.memory} MB, ${size.disk} GB disk)`);
  console.log(`    Cost:    $${size.price_monthly}/mo, billed by DigitalOcean until you delete it`);
  console.log('');

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('Creating a droplet needs confirmation. Re-run with --yes to create it without asking.');
    }
    if (!(await confirm('  Create it? [y/N] '))) throw new Error('Cancelled. Nothing was created.');
    console.log('');
  }

  const key = ensureDeployKey();
  const keyId = await api.ensureSshKey(key.publicKey);

  console.log('  Creating droplet...');
  const created = await api.createDroplet({
    name,
    region,
    size: sizeSlug,
    image: DROPLET_IMAGE,
    sshKeyIds: [keyId],
    userData: cloudInit(),
    stack: detection.stack,
  });
  const droplet = await api.waitForActive(created.id);
  forgetHost(publicIp(droplet)!);
  return droplet;
}

async function isAnswering(url: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means Caddy reached the app; a 502 means it has not started yet.
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      if (res.status !== 502 && res.status !== 503) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 4_000));
  }
  return false;
}

export async function deployToDroplet(
  api: DigitalOcean,
  cwd: string,
  detected: ProjectDetection,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const name = dropletName(options.name ?? detected.name);
  // The Compose project, database and database user are all named after the app.
  const detection: ProjectDetection = { ...detected, name };

  let env: Record<string, string> = {};
  if (options.envFile) {
    if (!existsSync(options.envFile)) throw new Error(`Env file not found: ${options.envFile}`);
    env = parseEnvFile(readFileSync(options.envFile, 'utf-8'));
    console.log(`  Loaded ${Object.keys(env).length} env vars from ${options.envFile}`);
  }

  let droplet = await api.findAppDroplet(name);
  const created = !droplet;
  if (droplet) {
    if (droplet.status !== 'active') {
      throw new Error(`Droplet ${name} exists but is "${droplet.status}". Power it on in DigitalOcean and try again.`);
    }
    console.log(`  ♻️  Redeploying to droplet ${name} (${publicIp(droplet)})`);
    if (options.size || options.region) {
      console.log('     --size and --region only apply when the droplet is first created.');
    }
    ensureDeployKey();
  } else {
    droplet = await provision(api, name, detection, options);
  }

  // After the droplet exists, because DigitalOcean only accepts a tag that is in use.
  if (await api.ensureFirewall()) {
    console.log(`  🔒 Firewall "${FIREWALL_NAME}" on: only SSH, HTTP and HTTPS reach turkeycode droplets.`);
  }

  const ip = publicIp(droplet);
  if (!ip) throw new Error(`Droplet ${name} has no public address.`);

  console.log(`  Waiting for SSH on ${ip}...`);
  await waitForSsh(ip);

  // buildCompose also writes Dockerfile.turkeycode when the project has no
  // Dockerfile, so it has to run before the tarball is made.
  const compose = productionCompose(buildCompose(detection, cwd, { loadDotEnv: false }), {
    appPort: resolveAppPort(detection, cwd),
    domain: options.domain,
    envKeys: Object.keys(env),
  });
  const dependencies = Object.keys(compose.services).filter(s => s !== 'app' && s !== 'caddy');

  console.log('  Packaging...');
  // The image is built on the droplet, so there is no local build step.
  const pkg = await packageApp(detection, cwd, { skipBuild: true });
  console.log(`  Package: ${pkg.sizeMB}MB`);

  const staging = mkdtempSync(join(tmpdir(), 'turkeycode-deploy-'));
  try {
    const composePath = join(staging, 'compose.yml');
    const envPath = join(staging, 'app.env');
    writeFileSync(composePath, composeToYaml(compose, '# Generated by turkeycode deploy\n\n'));
    writeFileSync(envPath, envFileContent(env), { mode: 0o600 });

    const remoteDir = `${REMOTE_ROOT}/${name}`;
    sshRun(ip, `mkdir -p ${remoteDir}`);
    console.log('  Uploading...');
    scp(ip, pkg.tarballPath, `${remoteDir}/release.tar.gz`);
    scp(ip, composePath, `${remoteDir}/compose.yml`);
    scp(ip, envPath, `${remoteDir}/app.env`);

    console.log('  Building and starting on the droplet (first deploy takes a few minutes)...');
    console.log('');
    sshRun(ip, 'bash -s', {
      input: remoteScript({ appName: name, dependencies, migrateCmd: resolveMigrateCmd(detection, cwd) }),
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(pkg.tarballPath, { force: true });
  }

  const ipUrl = `http://${ip}`;
  const live = await isAnswering(ipUrl);
  return { name, ip, url: options.domain ? `https://${options.domain}` : ipUrl, created, live };
}

/** Recent container logs for a deployed app. */
export function remoteLogs(ip: string, appName: string, lines: number): string {
  ensureDeployKey();
  const count = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 100;
  return sshRun(
    ip,
    `cd ${REMOTE_ROOT}/${appName}/src && ${composeCommand(appName)} logs --no-color --tail ${count}`,
    { capture: true }
  );
}
