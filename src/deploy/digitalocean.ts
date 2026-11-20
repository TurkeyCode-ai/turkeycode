/**
 * DigitalOcean API client for `turkeycode deploy`.
 *
 * Every call runs against the caller's own DigitalOcean account with their own
 * token. Nothing here talks to turkeycode.ai.
 */

const API_BASE = 'https://api.digitalocean.com/v2';

/** Tag on every droplet turkeycode creates; `turkeycode apps` lists by it. */
export const APP_TAG = 'turkeycode';
const STACK_TAG_PREFIX = 'tc-stack:';

/** One cloud firewall covers every droplet carrying APP_TAG. */
export const FIREWALL_NAME = 'turkeycode-apps';

const ANYWHERE = { addresses: ['0.0.0.0/0', '::/0'] };

/**
 * Inbound: SSH for deploys, HTTP and HTTPS for Caddy (UDP 443 is HTTP/3), ping.
 * Everything else is dropped before it reaches the droplet, which matters
 * because Docker publishes ports past a host firewall such as ufw.
 */
export const FIREWALL_INBOUND = [
  { protocol: 'tcp', ports: '22', sources: ANYWHERE },
  { protocol: 'tcp', ports: '80', sources: ANYWHERE },
  { protocol: 'tcp', ports: '443', sources: ANYWHERE },
  { protocol: 'udp', ports: '443', sources: ANYWHERE },
  { protocol: 'icmp', sources: ANYWHERE },
];

export const FIREWALL_OUTBOUND = [
  { protocol: 'tcp', ports: 'all', destinations: ANYWHERE },
  { protocol: 'udp', ports: 'all', destinations: ANYWHERE },
  { protocol: 'icmp', destinations: ANYWHERE },
];

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Droplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  size_slug: string;
  size?: { price_monthly?: number };
  region?: { slug?: string };
  tags?: string[];
  networks?: { v4?: Array<{ ip_address: string; type: string }> };
}

export interface DropletSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  price_monthly: number;
  available: boolean;
  regions: string[];
}

export interface CreateDropletInput {
  name: string;
  region: string;
  size: string;
  image: string;
  sshKeyIds: number[];
  userData: string;
  stack: string;
}

export class DigitalOceanError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function publicIp(droplet: Droplet): string | null {
  return droplet.networks?.v4?.find(n => n.type === 'public')?.ip_address ?? null;
}

export function stackOf(droplet: Droplet): string {
  const tag = droplet.tags?.find(t => t.startsWith(STACK_TAG_PREFIX));
  return tag ? tag.slice(STACK_TAG_PREFIX.length) : 'unknown';
}

/** DigitalOcean tags allow letters, numbers, colons, dashes and underscores. */
export function stackTag(stack: string): string {
  return STACK_TAG_PREFIX + stack.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** A droplet name is a hostname: lowercase letters, digits and dashes. */
export function dropletName(appName: string): string {
  const name = appName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  if (!name) throw new Error(`"${appName}" has no characters usable in a droplet name. Pass --name.`);
  return name;
}

/** The key material of an OpenSSH public key line, without its comment. */
function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
}

export class DigitalOcean {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      let message = `DigitalOcean API error: ${res.status} ${res.statusText}`;
      try {
        const body = await res.json() as { message?: string };
        if (body.message) message = `DigitalOcean: ${body.message}`;
      } catch { /* no JSON body */ }
      if (res.status === 401) {
        message = 'DigitalOcean rejected the token. Create one with read and write access at ' +
          'https://cloud.digitalocean.com/account/api/tokens, then run: turkeycode login --token <token>';
      }
      throw new DigitalOceanError(message, res.status);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async getAccount(): Promise<{ email: string; droplet_limit: number; status: string }> {
    const data = await this.request<{ account: { email: string; droplet_limit: number; status: string } }>('/account');
    return data.account;
  }

  /** Register the deploy key in the account, or find it if it is already there. */
  async ensureSshKey(publicKey: string, name = 'turkeycode-deploy'): Promise<number> {
    const wanted = keyBody(publicKey);
    const existing = await this.request<{ ssh_keys: Array<{ id: number; public_key: string }> }>(
      '/account/keys?per_page=200'
    );
    const match = existing.ssh_keys.find(k => keyBody(k.public_key) === wanted);
    if (match) return match.id;

    const created = await this.request<{ ssh_key: { id: number } }>('/account/keys', {
      method: 'POST',
      body: JSON.stringify({ name, public_key: publicKey.trim() }),
    });
    return created.ssh_key.id;
  }

  /**
   * Make sure the account has the turkeycode firewall and that it applies to
   * the app tag. A firewall with that name is left as the owner set it up,
   * apart from adding the tag if it is missing. Returns true when it changed
   * something.
   */
  async ensureFirewall(): Promise<boolean> {
    const data = await this.request<{ firewalls: Array<{ id: string; name: string; tags?: string[] }> }>(
      '/firewalls?per_page=200'
    );
    const existing = data.firewalls.find(f => f.name === FIREWALL_NAME);
    if (existing) {
      if (existing.tags?.includes(APP_TAG)) return false;
      await this.request<void>(`/firewalls/${existing.id}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tags: [APP_TAG] }),
      });
      return true;
    }

    await this.request<unknown>('/firewalls', {
      method: 'POST',
      body: JSON.stringify({
        name: FIREWALL_NAME,
        inbound_rules: FIREWALL_INBOUND,
        outbound_rules: FIREWALL_OUTBOUND,
        tags: [APP_TAG],
      }),
    });
    return true;
  }

  async listAppDroplets(): Promise<Droplet[]> {
    const data = await this.request<{ droplets: Droplet[] }>(
      `/droplets?tag_name=${encodeURIComponent(APP_TAG)}&per_page=200`
    );
    return data.droplets;
  }

  async findAppDroplet(name: string): Promise<Droplet | null> {
    const droplets = await this.listAppDroplets();
    return droplets.find(d => d.name === name) ?? null;
  }

  async getSize(slug: string): Promise<DropletSize | null> {
    const data = await this.request<{ sizes: DropletSize[] }>('/sizes?per_page=200');
    return data.sizes.find(s => s.slug === slug) ?? null;
  }

  async createDroplet(input: CreateDropletInput): Promise<Droplet> {
    const data = await this.request<{ droplet: Droplet }>('/droplets', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        region: input.region,
        size: input.size,
        image: input.image,
        ssh_keys: input.sshKeyIds,
        user_data: input.userData,
        tags: [APP_TAG, stackTag(input.stack)],
        monitoring: true,
      }),
    });
    return data.droplet;
  }

  async getDroplet(id: number): Promise<Droplet> {
    const data = await this.request<{ droplet: Droplet }>(`/droplets/${id}`);
    return data.droplet;
  }

  /** Poll until the droplet is running and has a public address. */
  async waitForActive(
    id: number,
    options: { timeoutMs?: number; intervalMs?: number; onTick?: (status: string) => void } = {}
  ): Promise<Droplet> {
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const intervalMs = options.intervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const droplet = await this.getDroplet(id);
      options.onTick?.(droplet.status);
      if (droplet.status === 'active' && publicIp(droplet)) return droplet;
      if (Date.now() >= deadline) {
        throw new Error(`Droplet ${id} was not running after ${Math.round(timeoutMs / 1000)}s (status: ${droplet.status}).`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  async deleteDroplet(id: number): Promise<void> {
    await this.request<void>(`/droplets/${id}`, { method: 'DELETE' });
  }
}
