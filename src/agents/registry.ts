/**
 * Backend registry: built-ins + user-defined agents from
 * ~/.turkeycode/agents.yaml, and the process-wide active backend.
 *
 * The active backend is set ONCE at CLI entry (the setStrictQA idiom) so the
 * spawner and prompt builders can read it without constructor threading.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { AgentBackendSpec } from './types';
import { CLAUDE_BACKEND } from './claude';
import { CODEX_BACKEND } from './codex';
import { GEMINI_BACKEND } from './gemini';
import { OPENCODE_BACKEND } from './opencode';

export const AGENTS_CONFIG_PATH = join(homedir(), '.turkeycode', 'agents.yaml');

export const BUILTIN_BACKENDS: Record<string, AgentBackendSpec> = {
  claude: CLAUDE_BACKEND,
  codex: CODEX_BACKEND,
  gemini: GEMINI_BACKEND,
  opencode: OPENCODE_BACKEND,
};

function asStringArray(v: unknown, path: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new Error(`agents.yaml: ${path} must be an array of strings`);
  }
  return v as string[];
}

function compileCheck(patterns: string[], path: string): string[] {
  for (const p of patterns) {
    try {
      new RegExp(p, 'i');
    } catch (e) {
      throw new Error(`agents.yaml: ${path} contains invalid regex "${p}": ${(e as Error).message}`);
    }
  }
  return patterns;
}

/** Parse one agents.yaml entry into a full spec, with defaults. */
function parseAgentEntry(raw: unknown, idx: number): AgentBackendSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`agents.yaml: entry at index ${idx} is not an object`);
  }
  const e = raw as Record<string, unknown>;
  const where = `agents[${idx}]`;

  if (typeof e.id !== 'string' || !e.id) {
    throw new Error(`agents.yaml: ${where} is missing required 'id'`);
  }
  if (typeof e.binary !== 'string' || !e.binary) {
    throw new Error(`agents.yaml: ${where} ('${e.id}') is missing required 'binary'`);
  }
  const promptDelivery = e.promptDelivery ?? 'stdin';
  if (promptDelivery !== 'stdin' && promptDelivery !== 'arg') {
    throw new Error(`agents.yaml: ${where}.promptDelivery must be 'stdin' or 'arg'`);
  }

  const env = (e.env ?? {}) as Record<string, unknown>;
  const classifiers = (e.classifiers ?? {}) as Record<string, unknown>;
  const models = (e.models ?? {}) as Record<string, unknown>;
  const tiers = (models.tiers ?? {}) as Record<string, unknown>;
  const caps = (e.capabilities ?? {}) as Record<string, unknown>;

  return {
    id: e.id,
    displayName: typeof e.displayName === 'string' ? e.displayName : e.id,
    binary: e.binary,
    baseArgs: asStringArray(e.baseArgs, `${where}.baseArgs`),
    promptDelivery,
    promptFlag: typeof e.promptFlag === 'string' ? e.promptFlag : undefined,
    stdinSentinelArg: typeof e.stdinSentinelArg === 'string' ? e.stdinSentinelArg : undefined,
    modelFlag: typeof e.modelFlag === 'string' ? e.modelFlag : undefined,
    mcpConfigFlag: typeof e.mcpConfigFlag === 'string' ? e.mcpConfigFlag : undefined,
    blindFlags: Array.isArray(e.blindFlags) ? e.blindFlags.map(String) : undefined,
    env: {
      apiKeyVar: typeof env.apiKeyVar === 'string' ? env.apiKeyVar : undefined,
      stripApiKeyByDefault: env.stripApiKeyByDefault === true,
      nestedGuardVars: asStringArray(env.nestedGuardVars, `${where}.env.nestedGuardVars`),
    },
    versionArgs: e.versionArgs === undefined ? ['--version'] : asStringArray(e.versionArgs, `${where}.versionArgs`),
    installHint: typeof e.installHint === 'string' ? e.installHint : `install the '${e.binary}' CLI`,
    setupHint: typeof e.setupHint === 'string' ? e.setupHint : undefined,
    billingHint: typeof e.billingHint === 'string' ? e.billingHint : undefined,
    classifiers: {
      rateLimit: compileCheck(
        classifiers.rateLimit === undefined
          ? ['rate.?limit', '\\b429\\b', 'too many requests']
          : asStringArray(classifiers.rateLimit, `${where}.classifiers.rateLimit`),
        `${where}.classifiers.rateLimit`
      ),
      creditExhausted: compileCheck(
        asStringArray(classifiers.creditExhausted, `${where}.classifiers.creditExhausted`),
        `${where}.classifiers.creditExhausted`
      ),
      apiErrorContext: compileCheck(
        classifiers.apiErrorContext === undefined
          ? ['rate.?limit', '\\b429\\b', 'too many requests']
          : asStringArray(classifiers.apiErrorContext, `${where}.classifiers.apiErrorContext`),
        `${where}.classifiers.apiErrorContext`
      ),
    },
    models: {
      tiers: {
        high: typeof tiers.high === 'string' ? tiers.high : undefined,
        medium: typeof tiers.medium === 'string' ? tiers.medium : undefined,
        low: typeof tiers.low === 'string' ? tiers.low : undefined,
      },
      phaseOverrides:
        models.phaseOverrides && typeof models.phaseOverrides === 'object'
          ? Object.fromEntries(
              Object.entries(models.phaseOverrides as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string'
              ) as [string, string][]
            )
          : undefined,
    },
    // Capabilities default to false: a custom CLI must declare what it can do.
    capabilities: {
      subagents: caps.subagents === true,
      skills: caps.skills === true,
      mcpConfig: caps.mcpConfig === true,
      multimodalImages: caps.multimodalImages === true,
    },
  };
}

/**
 * Load user-defined agents from agents.yaml. Missing file -> empty list.
 * Entries may override built-ins by reusing their id.
 */
export function loadCustomAgents(configPath: string = AGENTS_CONFIG_PATH): AgentBackendSpec[] {
  if (!existsSync(configPath)) return [];

  const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid agents.yaml at ${configPath}: expected a YAML object`);
  }
  const agents = (parsed as Record<string, unknown>).agents;
  if (agents === undefined) return [];
  if (!Array.isArray(agents)) {
    throw new Error(`Invalid agents.yaml at ${configPath}: 'agents' must be an array`);
  }
  return agents.map((raw, idx) => parseAgentEntry(raw, idx));
}

/** Built-ins merged with agents.yaml (custom entries win on id collision). */
export function getAllBackends(configPath: string = AGENTS_CONFIG_PATH): Record<string, AgentBackendSpec> {
  const all = { ...BUILTIN_BACKENDS };
  for (const spec of loadCustomAgents(configPath)) {
    all[spec.id] = spec;
  }
  return all;
}

/** Look up a backend by id, or throw naming what exists. */
export function getBackend(id: string, configPath: string = AGENTS_CONFIG_PATH): AgentBackendSpec {
  const all = getAllBackends(configPath);
  const spec = all[id];
  if (!spec) {
    throw new Error(
      `Unknown agent backend '${id}'. Available: ${Object.keys(all).join(', ')} ` +
      `(add custom agents in ${AGENTS_CONFIG_PATH})`
    );
  }
  return spec;
}

/**
 * Decide which backend id a command should run with.
 * Precedence: --agent flag > TURKEYCODE_AGENT env > state.json pin > claude.
 * An explicit choice that CONFLICTS with a resumed run's pin is a hard error:
 * a build's artifacts and branches assume one agent's behavior end to end.
 */
export function resolveBackendId(options: {
  cliFlag?: string;
  stateAgent?: string;
} = {}): string {
  const explicit = options.cliFlag || process.env.TURKEYCODE_AGENT || undefined;
  const pinned = options.stateAgent;

  if (explicit && pinned && explicit !== pinned) {
    throw new Error(
      `This run was started with agent '${pinned}' but '${explicit}' was requested ` +
      `(via ${options.cliFlag ? '--agent' : 'TURKEYCODE_AGENT'}). ` +
      `Switching agents mid-run is not supported — resume without overriding the agent, ` +
      `or reset and start over.`
    );
  }
  return explicit || pinned || 'claude';
}

// ---------------------------------------------------------------------------
// Active backend (process-wide, set once at CLI entry)
// ---------------------------------------------------------------------------

let activeBackend: AgentBackendSpec = CLAUDE_BACKEND;

export function getActiveBackend(): AgentBackendSpec {
  return activeBackend;
}

export function setActiveBackend(idOrSpec: string | AgentBackendSpec): AgentBackendSpec {
  activeBackend = typeof idOrSpec === 'string' ? getBackend(idOrSpec) : idOrSpec;
  return activeBackend;
}
