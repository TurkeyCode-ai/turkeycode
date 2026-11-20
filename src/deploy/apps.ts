/**
 * turkeycode apps — list, logs, delete. An app is a droplet tagged `turkeycode`
 * in the caller's own DigitalOcean account.
 */

import { DigitalOcean, dropletName, publicIp, stackOf, type Droplet } from './digitalocean';
import { remoteLogs } from './droplet';

export interface DeployedApp {
  name: string;
  url: string;
  stack: string;
  size: string;
  region: string;
  status: string;
  priceMonthly: number | null;
  createdAt: string;
}

const STATUS_ICON: Record<string, string> = {
  active: '✅',
  new: '⏳',
  off: '⏹',
  archive: '📦',
};

export function toApp(droplet: Droplet): DeployedApp {
  const ip = publicIp(droplet);
  return {
    name: droplet.name,
    url: ip ? `http://${ip}` : '',
    stack: stackOf(droplet),
    size: droplet.size_slug,
    region: droplet.region?.slug ?? '',
    status: droplet.status,
    priceMonthly: droplet.size?.price_monthly ?? null,
    createdAt: droplet.created_at,
  };
}

export async function listApps(api: DigitalOcean): Promise<DeployedApp[]> {
  return (await api.listAppDroplets()).map(toApp);
}

async function requireDroplet(api: DigitalOcean, appName: string): Promise<Droplet> {
  const droplet = await api.findAppDroplet(dropletName(appName));
  if (!droplet) throw new Error(`No app named "${appName}" in this DigitalOcean account. Run: turkeycode apps`);
  return droplet;
}

export async function getAppStatus(api: DigitalOcean, appName: string): Promise<DeployedApp> {
  return toApp(await requireDroplet(api, appName));
}

export async function getAppLogs(api: DigitalOcean, appName: string, lines = 100): Promise<string> {
  const droplet = await requireDroplet(api, appName);
  const ip = publicIp(droplet);
  if (!ip) throw new Error(`Droplet ${droplet.name} has no public address.`);
  return remoteLogs(ip, droplet.name, lines);
}

/** Destroys the droplet and everything on it, including database volumes. */
export async function deleteApp(api: DigitalOcean, appName: string): Promise<void> {
  const droplet = await requireDroplet(api, appName);
  await api.deleteDroplet(droplet.id);
}

export function printApps(apps: DeployedApp[]): void {
  if (apps.length === 0) {
    console.log('No deployed apps. Run: turkeycode deploy');
    return;
  }

  const nameWidth = Math.max(4, ...apps.map(a => a.name.length));
  const stackWidth = Math.max(5, ...apps.map(a => a.stack.length));
  const sizeWidth = Math.max(4, ...apps.map(a => a.size.length));

  console.log('');
  console.log(
    `  ${'NAME'.padEnd(nameWidth)}  ${'STACK'.padEnd(stackWidth)}  ${'SIZE'.padEnd(sizeWidth)}  ${'$/MO'.padEnd(5)}  ${'STATUS'.padEnd(10)}  URL`
  );
  console.log('  ' + '-'.repeat(nameWidth + stackWidth + sizeWidth + 48));

  for (const app of apps) {
    const icon = STATUS_ICON[app.status] ?? '?';
    const price = app.priceMonthly === null ? '-' : String(app.priceMonthly);
    console.log(
      `  ${app.name.padEnd(nameWidth)}  ${app.stack.padEnd(stackWidth)}  ${app.size.padEnd(sizeWidth)}  ${price.padEnd(5)}  ${icon} ${app.status.padEnd(8)}  ${app.url}`
    );
  }
  console.log('');
}
