import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { detectProject } from '../deploy/detect';
import { APP_TAG, DigitalOcean, dropletName, stackTag, type FetchLike } from '../deploy/digitalocean';
import {
  cloudInit,
  defaultSize,
  envFileContent,
  parseEnvFile,
  productionCompose,
  remoteScript,
  resolveAppPort,
  shQuote,
} from '../deploy/droplet';
import { buildCompose, composeToYaml } from '../deploy/run-local';

// ============================================================================
// DigitalOcean client — against a fake fetch, never the network
// ============================================================================

interface Call { url: string; method: string; auth: string | undefined; body: any }

function fakeApi(routes: Record<string, (call: Call) => { status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method,
      auth: headers.Authorization,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = url.replace('https://api.digitalocean.com/v2', '').split('?')[0];
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no route ${method} ${path}` }), { status: 404 });
    const { status = 200, json } = route(call);
    return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status });
  };
  return { api: new DigitalOcean('dop_v1_client_token', fetchImpl), calls };
}

describe('deploy/digitalocean', () => {
  it('only ever calls api.digitalocean.com, with the caller\'s token', async () => {
    const { api, calls } = fakeApi({
      'GET /account': () => ({ json: { account: { email: 'client@example.com', droplet_limit: 10, status: 'active' } } }),
      'GET /droplets': () => ({ json: { droplets: [] } }),
    });
    expect((await api.getAccount()).email).toBe('client@example.com');
    await api.listAppDroplets();
    for (const call of calls) {
      expect(call.url.startsWith('https://api.digitalocean.com/v2/')).toBe(true);
      expect(call.auth).toBe('Bearer dop_v1_client_token');
    }
  });

  it('lists only droplets carrying the turkeycode tag', async () => {
    const { api, calls } = fakeApi({ 'GET /droplets': () => ({ json: { droplets: [] } }) });
    await api.listAppDroplets();
    expect(calls[0].url).toContain(`tag_name=${APP_TAG}`);
  });

  it('finds an app by its droplet name, and nothing for a name that is not there', async () => {
    const { api } = fakeApi({
      'GET /droplets': () => ({ json: { droplets: [
        { id: 1, name: 'shop', status: 'active', created_at: '', size_slug: 's' },
        { id: 2, name: 'shop-admin', status: 'active', created_at: '', size_slug: 's' },
      ] } }),
    });
    expect((await api.findAppDroplet('shop-admin'))?.id).toBe(2);
    expect(await api.findAppDroplet('blog')).toBeNull();
  });

  it('reuses a deploy key already in the account, ignoring its comment', async () => {
    const { api, calls } = fakeApi({
      'GET /account/keys': () => ({ json: { ssh_keys: [
        { id: 11, public_key: 'ssh-ed25519 AAAAother someone' },
        { id: 12, public_key: 'ssh-ed25519 AAAAmine old-comment' },
      ] } }),
    });
    expect(await api.ensureSshKey('ssh-ed25519 AAAAmine turkeycode-deploy\n')).toBe(12);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('registers the deploy key when the account does not have it', async () => {
    const { api, calls } = fakeApi({
      'GET /account/keys': () => ({ json: { ssh_keys: [] } }),
      'POST /account/keys': () => ({ status: 201, json: { ssh_key: { id: 99 } } }),
    });
    expect(await api.ensureSshKey('ssh-ed25519 AAAAmine turkeycode-deploy')).toBe(99);
    expect(calls[1].body).toEqual({ name: 'turkeycode-deploy', public_key: 'ssh-ed25519 AAAAmine turkeycode-deploy' });
  });

  it('creates the droplet tagged, with the key and first-boot script', async () => {
    const { api, calls } = fakeApi({
      'POST /droplets': () => ({ status: 202, json: { droplet: { id: 5, name: 'shop', status: 'new', created_at: '', size_slug: 's-1vcpu-1gb' } } }),
    });
    const droplet = await api.createDroplet({
      name: 'shop', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
      sshKeyIds: [12], userData: cloudInit(), stack: 'nextjs',
    });
    expect(droplet.id).toBe(5);
    expect(calls[0].body).toMatchObject({
      name: 'shop', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64',
      ssh_keys: [12], tags: ['turkeycode', 'tc-stack:nextjs'],
    });
    expect(calls[0].body.user_data).toContain('get.docker.com');
  });

  it('waits until the droplet is active and has a public address', async () => {
    let polls = 0;
    const { api } = fakeApi({
      'GET /droplets/5': () => {
        polls++;
        return { json: { droplet: polls < 3
          ? { id: 5, name: 'shop', status: 'new', created_at: '', size_slug: 's', networks: { v4: [] } }
          : { id: 5, name: 'shop', status: 'active', created_at: '', size_slug: 's', networks: { v4: [{ ip_address: '203.0.113.9', type: 'public' }] } } } };
      },
    });
    const droplet = await api.waitForActive(5, { intervalMs: 1 });
    expect(droplet.status).toBe('active');
    expect(polls).toBe(3);
  });

  it('gives up waiting with the status it last saw', async () => {
    const { api } = fakeApi({
      'GET /droplets/5': () => ({ json: { droplet: { id: 5, name: 'shop', status: 'new', created_at: '', size_slug: 's' } } }),
    });
    await expect(api.waitForActive(5, { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(/status: new/);
  });

  it('turns a rejected token into instructions, and passes other API messages through', async () => {
    const bad = fakeApi({ 'GET /account': () => ({ status: 401, json: { message: 'Unable to authenticate you' } }) });
    await expect(bad.api.getAccount()).rejects.toThrow(/turkeycode login --token/);

    const limit = fakeApi({ 'POST /droplets': () => ({ status: 422, json: { message: 'droplet limit exceeded' } }) });
    await expect(limit.api.createDroplet({
      name: 'a', region: 'nyc3', size: 's', image: 'i', sshKeyIds: [], userData: '', stack: 'node',
    })).rejects.toThrow('DigitalOcean: droplet limit exceeded');
  });

  it('deletes by id and accepts the empty 204 answer', async () => {
    const { api, calls } = fakeApi({ 'DELETE /droplets/5': () => ({ status: 204 }) });
    await expect(api.deleteDroplet(5)).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
  });

  it('makes droplet names and stack tags DigitalOcean accepts', () => {
    expect(dropletName('@acme/My_Shop')).toBe('acme-my-shop');
    expect(dropletName('shop')).toBe('shop');
    expect(dropletName('a'.repeat(80)).length).toBe(63);
    expect(() => dropletName('___')).toThrow(/--name/);
    expect(stackTag('next.js')).toBe('tc-stack:next-js');
  });
});

// ============================================================================
// What runs on the droplet
// ============================================================================

describe('deploy/droplet', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-droplet-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function project(pkg: object, files: Record<string, string> = {}) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return detectProject(dir);
  }

  const withPostgres = { name: 'shop', dependencies: { express: '^4', '@prisma/client': '^5', ioredis: '^5' } };

  it('publishes nothing but Caddy, so the database is not on the internet', () => {
    const detection = project(withPostgres);
    const compose = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), { appPort: 3000 });

    expect(compose.services.postgres.ports).toBeUndefined();
    expect(compose.services.redis.ports).toBeUndefined();
    expect(compose.services.app.ports).toBeUndefined();
    expect(compose.services.caddy.ports).toEqual(['80:80', '443:443']);
    expect(compose.services.caddy.command).toBe('caddy reverse-proxy --from :80 --to app:3000');
  });

  it('swaps the development passwords for the secret generated on the droplet', () => {
    const detection = project(withPostgres);
    const compose = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), { appPort: 3000 });
    const yaml = composeToYaml(compose);

    expect(compose.services.postgres.environment?.POSTGRES_PASSWORD).toBe('${DB_PASSWORD}');
    expect(compose.services.app.environment?.DATABASE_URL).toBe('postgresql://shop:${DB_PASSWORD}@postgres:5432/shop');
    expect(yaml).not.toContain('shop_dev');
    expect(yaml).toContain('caddy_data:');
  });

  it('never ships the local .env, but still does for run-local', () => {
    const detection = project(withPostgres, { '.env': 'STRIPE_SECRET=sk_live_local\n' });

    const deployed = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), { appPort: 3000 });
    expect(composeToYaml(deployed)).not.toContain('sk_live_local');
    expect(deployed.services.app.env_file).toEqual(['../app.env']);

    expect(buildCompose(detection, dir).services.app.environment?.STRIPE_SECRET).toBe('sk_live_local');
  });

  it('lets a value from --env win over the generated one', () => {
    const detection = project(withPostgres);
    const compose = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), {
      appPort: 3000,
      envKeys: ['DATABASE_URL'],
    });
    expect(compose.services.app.environment?.DATABASE_URL).toBeUndefined();
    expect(compose.services.app.environment?.REDIS_URL).toBe('redis://redis:6379');
  });

  it('serves a domain over HTTPS by handing it to Caddy', () => {
    const detection = project({ name: 'site', dependencies: { express: '^4' } });
    const compose = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), {
      appPort: 3000,
      domain: 'shop.example.com',
    });
    expect(compose.services.caddy.command).toBe('caddy reverse-proxy --from shop.example.com --to app:3000');
  });

  it('generates the Dockerfile before packaging when the project has none', () => {
    const detection = project({ name: 'site', dependencies: { express: '^4' }, scripts: { start: 'node index.js' } });
    buildCompose(detection, dir, { loadDotEnv: false });
    expect(existsSync(join(dir, 'Dockerfile.turkeycode'))).toBe(true);
  });

  it('routes to the port the container really listens on', () => {
    const node = project({ name: 'site', dependencies: { express: '^4' } });
    expect(resolveAppPort(node, dir)).toBe(3000);

    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 8080\nCMD ["node","x.js"]\n');
    expect(resolveAppPort(detectProject(dir), dir)).toBe(8080);

    rmSync(join(dir, 'Dockerfile'));
    rmSync(join(dir, 'package.json'));
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
    const site = detectProject(dir);
    expect(site.runtime).toBe('static');
    expect(resolveAppPort(site, dir)).toBe(80);
  });

  it('gives an app with a database a bigger droplet than one without', () => {
    expect(defaultSize(project(withPostgres))).toBe('s-1vcpu-2gb');
    expect(defaultSize(project({ name: 'site', dependencies: { express: '^4' } }))).toBe('s-1vcpu-1gb');
  });

  it('parses env files and writes them back so Compose takes values literally', () => {
    const env = parseEnvFile([
      '# comment',
      '',
      'PLAIN=value',
      'QUOTED="two words"',
      "SINGLE='it'",
      'export EXPORTED=yes',
      'WITH_EQUALS=a=b=c',
      'bad key=nope',
      'DOLLAR=pa$$word',
    ].join('\n'));

    expect(env).toEqual({
      PLAIN: 'value',
      QUOTED: 'two words',
      SINGLE: 'it',
      EXPORTED: 'yes',
      WITH_EQUALS: 'a=b=c',
      DOLLAR: 'pa$$word',
    });
    expect(envFileContent({ DOLLAR: 'pa$$word', APOS: "it's" })).toBe("DOLLAR='pa$$word'\nAPOS='it\\'s'\n");
    expect(envFileContent({})).toBe('');
  });

  it('writes a remote script that builds, waits for services, migrates, then starts', () => {
    const script = remoteScript({
      appName: 'shop',
      dependencies: ['postgres', 'redis'],
      migrateCmd: `npx prisma migrate deploy && echo 'done'`,
    });
    const dc = 'docker compose --env-file ../secrets.env -f docker-compose.turkeycode.yml -p shop';

    expect(script.startsWith('set -euo pipefail')).toBe(true);
    expect(script).toContain('cd /opt/turkeycode/shop');
    const order = [
      'cloud-init status --wait',
      'openssl rand -hex 24',
      'tar -xzf release.tar.gz -C src.new',
      `${dc} build </dev/null`,
      `${dc} up -d --quiet-pull --wait postgres redis </dev/null`,
      `${dc} run --rm -T app sh -c 'npx prisma migrate deploy && echo '\\''done'\\''' </dev/null`,
      `${dc} up -d --quiet-pull --remove-orphans </dev/null`,
    ].map(step => script.indexOf(step));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('never lets a container read the script it is being run from', () => {
    // The script is piped to `bash -s` over SSH. A real deploy stopped right
    // after the migration because `compose run` swallowed the rest of it.
    const script = remoteScript({ appName: 'shop', dependencies: ['postgres'], migrateCmd: 'npm run migrate' });
    const composeLines = script.split('\n').filter(l => l.startsWith('docker compose '));
    expect(composeLines.length).toBe(4);
    for (const line of composeLines) expect(line, line).toContain('</dev/null');
  });

  it('leaves the obsolete version key out of the droplet compose file', () => {
    const detection = project(withPostgres);
    const compose = productionCompose(buildCompose(detection, dir, { loadDotEnv: false }), { appPort: 3000 });
    expect(composeToYaml(compose)).not.toContain('version:');
    expect(composeToYaml(buildCompose(detection, dir))).toContain('version: "3.8"');
  });

  it('keeps the generated database secret across redeploys', () => {
    const script = remoteScript({ appName: 'shop', dependencies: [] });
    expect(script).toContain('if [ ! -f secrets.env ]; then');
    expect(script).not.toContain('rm -rf secrets.env');
    expect(script).not.toContain('up -d --wait');
    expect(script).not.toContain('Migrating');
  });

  it('quotes shell arguments safely', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote(`a'b; rm -rf /`)).toBe(`'a'\\''b; rm -rf /'`);
  });

  it('installs Docker and swap on first boot', () => {
    const userData = cloudInit();
    expect(userData.startsWith('#cloud-config\n')).toBe(true);
    expect(userData).toContain('size: 2G');
    expect(userData).toContain('get.docker.com');
  });
});

// ============================================================================
// Nothing in the deploy path points at the old hosted service
// ============================================================================

describe('deploy no longer uses turkeycode.ai', () => {
  it('has no turkeycode.ai API calls left in the deploy modules or the CLI', () => {
    const root = join(__dirname, '..');
    for (const file of ['deploy/auth.ts', 'deploy/apps.ts', 'deploy/droplet.ts', 'deploy/digitalocean.ts', 'deploy/package.ts', 'index.ts']) {
      expect(readFileSync(join(root, file), 'utf-8'), file).not.toMatch(/turkeycode\.ai\/api/);
    }
    expect(existsSync(join(root, 'deploy/upload.ts'))).toBe(false);
  });
});
