/**
 * turkey login — Authentication with turkeycode.ai
 * Stores credentials at ~/.turkeycode/credentials.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API_BASE = 'https://turkeycode.ai/api/v1';
const CREDS_DIR = join(homedir(), '.turkeycode');
const CREDS_PATH = join(CREDS_DIR, 'credentials.json');

export interface Credentials {
  token: string;
  email: string;
  tier: string;
}

export function getCredentials(): Credentials | null {
  if (!existsSync(CREDS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  if (!existsSync(CREDS_DIR)) {
    mkdirSync(CREDS_DIR, { recursive: true });
  }
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function isLoggedIn(): boolean {
  return getCredentials() !== null;
}

async function validateToken(token: string): Promise<{ email: string; tier: string }> {
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid token. Check your API key at https://turkeycode.ai/settings');
    }
    throw new Error(`Auth failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { email: string; tier: string };
  return data;
}

export async function login(options: { token?: string }): Promise<void> {
  if (options.token) {
    // Headless / CI mode
    console.log('Verifying token...');
    try {
      const { email, tier } = await validateToken(options.token);
      saveCredentials({ token: options.token, email, tier });
      console.log(`✅ Logged in as ${email} (${tier} tier)`);
    } catch (err) {
      console.error(`Login failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // Browser-based OAuth flow
  const loginUrl = `${API_BASE.replace('/api/v1', '')}/login/cli`;
  console.log('');
  console.log('Open this URL in your browser to authenticate:');
  console.log('');
  console.log(`  ${loginUrl}`);
  console.log('');
  console.log('After logging in, run:');
  console.log('  turkey login --token <your-api-key>');
  console.log('');
  console.log('You can find your API key at https://turkeycode.ai/settings/api-keys');
}

export function requireAuth(): Credentials {
  const creds = getCredentials();
  if (!creds) {
    console.error('Not logged in. Run: turkey login');
    process.exit(1);
  }
  return creds;
}
