/**
 * turkeycode login — the caller's own DigitalOcean API token.
 *
 * `turkeycode deploy` creates droplets in whatever account this token belongs
 * to. The token comes from the environment (DIGITALOCEAN_ACCESS_TOKEN, the name
 * doctl uses, or DIGITALOCEAN_TOKEN) or from ~/.turkeycode/credentials.json,
 * which `turkeycode login --token` writes. It is only ever sent to
 * api.digitalocean.com.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DigitalOcean } from './digitalocean';

const CREDS_DIR = join(homedir(), '.turkeycode');
const CREDS_PATH = join(CREDS_DIR, 'credentials.json');

export const TOKEN_ENV_VARS = ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_TOKEN'] as const;
const TOKENS_URL = 'https://cloud.digitalocean.com/account/api/tokens';

export interface Credentials {
  token: string;
  email: string;
}

export interface ResolvedToken {
  token: string;
  /** Where it came from, for the "Using ..." line. */
  source: string;
}

export function getCredentials(path: string = CREDS_PATH): Credentials | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Credentials> & { tier?: unknown };
    // A file with a tier is a login to the old turkeycode.ai hosting, not a
    // DigitalOcean token. Never send that to DigitalOcean.
    if ('tier' in parsed) return null;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    return { token: parsed.token, email: typeof parsed.email === 'string' ? parsed.email : '' };
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials, path: string = CREDS_PATH): void {
  if (path === CREDS_PATH && !existsSync(CREDS_DIR)) {
    mkdirSync(CREDS_DIR, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** The environment wins over the saved login, so CI can override per run. */
export function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  credsPath: string = CREDS_PATH
): ResolvedToken | null {
  for (const name of TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return { token: value, source: name };
  }
  const creds = getCredentials(credsPath);
  if (creds) return { token: creds.token, source: 'turkeycode login' };
  return null;
}

function printTokenHelp(): void {
  console.log('turkeycode deploys to your own DigitalOcean account.');
  console.log('');
  console.log('  1. Create an API token with read and write access:');
  console.log(`       ${TOKENS_URL}`);
  console.log('  2. Give it to turkeycode, either way:');
  console.log('       turkeycode login --token <token>');
  console.log(`       export ${TOKEN_ENV_VARS[0]}=<token>`);
  console.log('');
}

export async function login(options: { token?: string }): Promise<void> {
  if (!options.token) {
    printTokenHelp();
    return;
  }

  console.log('Checking the token with DigitalOcean...');
  try {
    const account = await new DigitalOcean(options.token).getAccount();
    saveCredentials({ token: options.token, email: account.email });
    console.log(`✅ Saved. Deploys will go to the DigitalOcean account ${account.email}`);
  } catch (err) {
    console.error(`Login failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function requireToken(): ResolvedToken {
  const resolved = resolveToken();
  if (!resolved) {
    console.error('No DigitalOcean token found.');
    console.error('');
    printTokenHelp();
    process.exit(1);
  }
  return resolved;
}
