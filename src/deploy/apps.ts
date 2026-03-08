/**
 * turkey apps — list, logs, delete deployed apps
 */

const API_BASE = 'https://turkeycode.ai/api/v1';

export interface DeployedApp {
  name: string;
  url: string;
  tier: string;
  stack: string;
  status: string;
  createdAt: string;
  lastDeployed: string;
}

const STATUS_ICON: Record<string, string> = {
  running: '✅',
  sleeping: '💤',
  provisioning: '⏳',
  stopped: '⏹',
  failed: '❌',
};

async function apiRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    let errMsg = `API error: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) errMsg = body.error;
    } catch { /* ignore */ }
    throw new Error(errMsg);
  }

  return res.json() as Promise<T>;
}

export async function listApps(token: string): Promise<DeployedApp[]> {
  const data = await apiRequest<{ apps: DeployedApp[] }>('/apps', token);
  return data.apps;
}

export function printApps(apps: DeployedApp[]): void {
  if (apps.length === 0) {
    console.log('No deployed apps. Run: turkey deploy');
    return;
  }

  const nameWidth = Math.max(4, ...apps.map(a => a.name.length));
  const stackWidth = Math.max(5, ...apps.map(a => a.stack.length));

  console.log('');
  console.log(
    `  ${'NAME'.padEnd(nameWidth)}  ${'STACK'.padEnd(stackWidth)}  ${'TIER'.padEnd(8)}  ${'STATUS'.padEnd(12)}  URL`
  );
  console.log('  ' + '-'.repeat(nameWidth + stackWidth + 50));

  for (const app of apps) {
    const icon = STATUS_ICON[app.status] ?? '?';
    const status = `${icon} ${app.status}`.padEnd(14);
    console.log(
      `  ${app.name.padEnd(nameWidth)}  ${app.stack.padEnd(stackWidth)}  ${app.tier.padEnd(8)}  ${status}  ${app.url}`
    );
  }
  console.log('');
}

export async function getAppLogs(appName: string, token: string, lines = 100): Promise<string[]> {
  const data = await apiRequest<{ logs: string[] }>(
    `/apps/${encodeURIComponent(appName)}/logs`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    }
  );
  return data.logs;
}

export async function deleteApp(appName: string, token: string): Promise<void> {
  await apiRequest<void>(`/apps/${encodeURIComponent(appName)}`, token, {
    method: 'DELETE',
  });
}

export async function getAppStatus(appName: string, token: string): Promise<DeployedApp> {
  const data = await apiRequest<{ app: DeployedApp }>(
    `/apps/${encodeURIComponent(appName)}`,
    token
  );
  return data.app;
}
