/**
 * Which MCP servers a session may reach.
 *
 * An agent CLI loads every MCP server its user has connected: mail, drive,
 * calendar, payments, memory. turkeycode's sessions run unattended with
 * approval prompts off, so by default they get none of those: only servers
 * turkeycode was explicitly given (TURKEYCODE_MCP_CONFIG / --mcp-config),
 * plus any user-level servers the owner chose to keep.
 *
 * The keep list comes from TURKEYCODE_KEEP_MCP (comma-separated names) or,
 * failing that, "keepMcpServers" in ~/.turkeycode/config.json. The value
 * "all" restores the old behaviour: sessions see everything the user has.
 *
 * Besides the exposure, each connected server's tool definitions are re-read
 * on every turn of every session.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { AgentBackendSpec } from './types';

export const KEEP_ALL = 'all';

type ServerMap = Record<string, unknown>;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serversIn(path: string | undefined): ServerMap {
  if (!path || !existsSync(path)) return {};
  const servers = readJson(path)?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as ServerMap) : {};
}

/** Names of user-level servers sessions keep. ['all'] means no isolation. */
export function keepList(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  const fromEnv = env.TURKEYCODE_KEEP_MCP;
  if (fromEnv !== undefined) {
    return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const fromFile = readJson(join(home, '.turkeycode', 'config.json'))?.keepMcpServers;
  if (Array.isArray(fromFile)) {
    return fromFile.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  }
  return [];
}

export interface SessionMcp {
  /** Cut the session off from the user's own MCP servers. */
  isolate: boolean;
  /** Config file holding exactly the servers the session may reach, if any. */
  configPath?: string;
  /** Kept names that were not found in the user's registry. */
  missing: string[];
}

/**
 * Work out what a non-blind session may reach and, when that is a set of
 * servers, write them to one config file under ~/.turkeycode (never inside a
 * project, and readable only by the owner: a server entry can carry a token).
 */
export function resolveSessionMcp(
  spec: AgentBackendSpec,
  explicitConfigPath: string | undefined,
  keep: string[] = keepList(),
  home: string = homedir()
): SessionMcp {
  // A backend that cannot isolate behaves as before: explicit config only.
  if (!spec.blindFlags?.length || !spec.mcpConfigFlag) {
    return { isolate: false, configPath: explicitConfigPath, missing: [] };
  }
  if (keep.includes(KEEP_ALL)) {
    return { isolate: false, configPath: explicitConfigPath, missing: [] };
  }

  const servers: ServerMap = {};
  const missing: string[] = [];
  if (keep.length > 0) {
    const registry = serversIn(spec.userMcpRegistry ? join(home, spec.userMcpRegistry) : undefined);
    for (const name of keep) {
      if (name in registry) servers[name] = registry[name];
      else missing.push(name);
    }
  }
  // Servers turkeycode was explicitly given win over a kept one of the same name.
  Object.assign(servers, serversIn(explicitConfigPath));

  if (Object.keys(servers).length === 0) return { isolate: true, missing };

  const body = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const configPath = join(home, '.turkeycode', 'session-mcp', `${digest}.json`);
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, body, { mode: 0o600 });
  }
  return { isolate: true, configPath, missing };
}
