/**
 * Upload tarball + manifest to turkeycode.ai/api/v1/deploy, poll status
 */

import { readFileSync, unlinkSync } from 'fs';
import type { ProjectDetection } from './detect';

const API_BASE = 'https://turkeycode.ai/api/v1';

export interface DeployManifest {
  name: string;
  version: string;
  stack: string;
  runtime: string;
  runtimeVersion: string;
  hasDockerfile: boolean;
  features: Record<string, boolean | string>;
  scripts: {
    install?: string;
    build?: string;
    start?: string;
    migrate?: string;
  };
  expose: number;
  env: Record<string, string>;
  tier: string;
}

export interface DeployResponse {
  deployId: string;
  appName: string;
  status: string;
  url: string;
}

export interface DeployStatus {
  deployId: string;
  status: 'provisioning' | 'installing' | 'migrating' | 'starting' | 'running' | 'failed';
  step: string;
  url: string;
  logs?: string[];
}

export interface DeployOptions {
  name?: string;
  tier?: string;
  envFile?: string;
  env?: Record<string, string>;
}

// Simple spinner using stdout
class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private current = 0;
  private interval: NodeJS.Timer | null = null;
  private text = '';

  start(text: string): void {
    this.text = text;
    this.current = 0;
    if (this.interval) clearInterval(this.interval as NodeJS.Timeout);
    process.stdout.write('\n');
    this.interval = setInterval(() => {
      const frame = this.frames[this.current % this.frames.length];
      process.stdout.write(`\r  ${frame} ${this.text}  `);
      this.current++;
    }, 80);
  }

  update(text: string): void {
    this.text = text;
  }

  stop(finalText?: string): void {
    if (this.interval) {
      clearInterval(this.interval as NodeJS.Timeout);
      this.interval = null;
    }
    if (finalText) {
      process.stdout.write(`\r  ${finalText}\n`);
    } else {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }
  }
}

const STATUS_MESSAGES: Record<string, string> = {
  provisioning: 'Provisioning container...',
  installing: 'Installing dependencies...',
  migrating: 'Running migrations...',
  starting: 'Starting app...',
  running: 'Configuring SSL...',
};

async function pollStatus(deployId: string, appName: string, token: string, spinner: Spinner): Promise<DeployStatus> {
  const maxAttempts = 120; // 2 minutes max
  const pollInterval = 3000; // 3 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollInterval));

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/deploy/${deployId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      // Network hiccup — keep polling
      continue;
    }

    if (!res.ok) {
      throw new Error(`Status poll failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as DeployStatus;

    const msg = data.step || STATUS_MESSAGES[data.status] || `Status: ${data.status}`;
    spinner.update(msg);

    if (data.status === 'running') {
      return data;
    }

    if (data.status === 'failed') {
      spinner.stop('✗ Deploy failed');
      const logs = data.logs?.slice(-10).join('\n').trim() ?? '';
      if (logs) {
        throw new Error(`Deploy failed:\n${logs}`);
      }
      // Server returned failure with no log lines attached. Tell the user
      // exactly where to look rather than leaving them with a blank "Deploy
      // failed." message.
      throw new Error(
        `Deploy failed. No error logs returned from the deploy service.\n` +
        `  Deploy ID: ${deployId}\n` +
        `  Next steps:\n` +
        `    • turkey apps logs ${appName}\n` +
        `    • turkey apps status ${appName}\n` +
        `    • https://turkeycode.ai/apps/${appName}`
      );
    }
  }

  throw new Error(`Deploy timed out after 2 minutes. Check status with: turkey apps status ${appName}`);
}

export async function uploadAndDeploy(
  tarballPath: string,
  detection: ProjectDetection,
  token: string,
  options: DeployOptions = {}
): Promise<DeployStatus> {
  const manifest: DeployManifest = {
    name: options.name ?? detection.name,
    version: detection.version,
    stack: detection.stack,
    runtime: detection.runtime,
    runtimeVersion: detection.runtimeVersion,
    hasDockerfile: detection.hasDockerfile,
    features: detection.features as unknown as Record<string, boolean | string>,
    scripts: detection.scripts,
    expose: detection.expose,
    env: options.env ?? {},
    tier: options.tier ?? detection.tier,
  };

  const spinner = new Spinner();
  spinner.start('Uploading...');

  // Build multipart form
  const tarballBytes = readFileSync(tarballPath);
  const form = new FormData();
  form.append('tarball', new Blob([tarballBytes], { type: 'application/gzip' }), `${manifest.name}.tar.gz`);
  form.append('manifest', JSON.stringify(manifest));

  let deployRes: Response;
  try {
    deployRes = await fetch(`${API_BASE}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    spinner.stop('✗ Upload failed');
    throw new Error(`Upload failed: ${(err as Error).message}`);
  } finally {
    // Clean up tarball
    try { unlinkSync(tarballPath); } catch { /* ignore */ }
  }

  if (!deployRes.ok) {
    spinner.stop('✗ Upload failed');
    let errMsg = `Upload failed: ${deployRes.status} ${deployRes.statusText}`;
    try {
      const errBody = await deployRes.json() as { error?: string };
      if (errBody.error) errMsg = errBody.error;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  const deploy = await deployRes.json() as DeployResponse;

  spinner.update('Provisioning container...');

  // Poll until running
  const status = await pollStatus(deploy.deployId, manifest.name, token, spinner);

  spinner.stop(`✅ Live at ${status.url}`);

  return status;
}
