/**
 * Agent backend model for turkeycode.
 *
 * A backend is DATA, not code: binary, flags, prompt delivery, env policy,
 * output classifiers, model tiers, capabilities. Built-in backends (claude,
 * codex, gemini, opencode) are expressed in the same schema a user can write
 * in ~/.turkeycode/agents.yaml, so wiring in a new print-mode agent CLI needs
 * no code changes.
 *
 * The orchestrator's contract with a session is backend-neutral already:
 * prompts in, done-files and artifacts on disk out (gates.ts). Anything that
 * can run shell commands and write files can hold up that contract.
 */

/** What a backend's CLI/runtime can do, consulted by prompt builders. */
export interface AgentCapabilities {
  /** Can spawn subagents from inside a session (Claude Code's Task tool). */
  subagents: boolean;
  /** Loads skills from a skill path (Claude Code skills). */
  skills: boolean;
  /** Accepts an MCP config file on the command line. */
  mcpConfig: boolean;
  /** The model behind the CLI can read image files (screenshot review). */
  multimodalImages: boolean;
}

/**
 * Output classifier patterns, as regex SOURCE STRINGS (compiled with the 'i'
 * flag) so YAML-defined backends can supply them as plain text.
 *
 * Semantics (see detectAgentSignals): credit exhaustion fires only when
 * credit wording co-occurs with an API-error marker — build/QA agents work on
 * real apps, and finance domains are saturated with "credit"/"balance"
 * wording that must not kill a build.
 */
export interface AgentClassifiers {
  /** Transient rate-limit wording (recovers in seconds). */
  rateLimit: string[];
  /** Credit/usage-exhaustion wording (resets at billing cycle, fail fast). */
  creditExhausted: string[];
  /** Markers that text is a real API error from THIS vendor, not app content. */
  apiErrorContext: string[];
}

/** Per-backend model configuration. */
export interface AgentModels {
  /**
   * Backend-specific model name per tier. A tier left out means "no flag" —
   * the CLI's own default model. Phases map to tiers via PHASE_TIERS.
   */
  tiers: { high?: string; medium?: string; low?: string };
  /** Exact-model pins for specific phases, overriding the tier mapping. */
  phaseOverrides?: Record<string, string>;
}

/** Environment policy for a backend's sessions. */
export interface AgentEnvPolicy {
  /** The vendor API key variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...). */
  apiKeyVar?: string;
  /**
   * Strip apiKeyVar by default so the CLI uses its login session (Claude
   * Max/Pro). TURKEYCODE_USE_API_KEY=1 keeps the key as the auth source.
   */
  stripApiKeyByDefault?: boolean;
  /** Vars that make the CLI think it's nested inside itself (CLAUDECODE). */
  nestedGuardVars?: string[];
}

/** A complete, spawnable description of an agent CLI. */
export interface AgentBackendSpec {
  /** Registry id: 'claude' | 'codex' | 'gemini' | 'opencode' | custom. */
  id: string;
  /** Human name for preflight/diagnostics text ("Claude Code"). */
  displayName: string;
  /** Binary name or absolute path. */
  binary: string;
  /** Always-on flags: print mode + full-autonomy (no approval prompts). */
  baseArgs: string[];
  /** How the prompt reaches the CLI. */
  promptDelivery: 'stdin' | 'arg';
  /** Flag preceding the prompt when promptDelivery is 'arg' (gemini: '-p'). */
  promptFlag?: string;
  /** Positional sentinel meaning "read prompt from stdin" (codex: '-'). */
  stdinSentinelArg?: string;
  /** Model flag ('--model', '-m'); omit = backend default model only. */
  modelFlag?: string;
  /** MCP config-file flag; omit = backend has no such flag. */
  mcpConfigFlag?: string;
  /**
   * Flags that cut a session off from the user's MCP servers. A memory server
   * registered at user level (aimem) holds the conversation that built the code,
   * so a reviewer that can reach it isn't blind. Omit = no such flag exists.
   */
  blindFlags?: string[];
  env: AgentEnvPolicy;
  /** Args for the preflight version check (['--version']). */
  versionArgs: string[];
  /** How to install the CLI, shown when the version check fails. */
  installHint: string;
  /** One-time setup after install (login), shown when the smoke test fails. */
  setupHint?: string;
  /** Where this vendor's credits live, shown on credit exhaustion. */
  billingHint?: string;
  classifiers: AgentClassifiers;
  models: AgentModels;
  capabilities: AgentCapabilities;
}

/**
 * Backend-neutral phase → tier mapping. Tiers, not model names, so every
 * backend gets the same cost/quality shape: 'high' where judgment is won or
 * lost (scope, plan, build, blocker debugging), 'low' for mechanical work.
 */
/**
 * An HTTP 429, not the digits 429. A bare \b429\b tripped on "34,429 bytes" in a
 * session's summary, which threw away a clean QA result and slept 5 minutes.
 */
export const HTTP_429_PATTERN =
  '(?:status|code|http|error)[^\\n]{0,24}\\b429\\b|\\b429\\b[^\\n]{0,24}(?:too many|rate|error)';

export const PHASE_TIERS: Record<string, keyof AgentModels['tiers']> = {
  'scope': 'high',
  'research': 'medium',
  'plan': 'high',
  'build': 'high',
  'qa-smoke': 'low',
  'qa-functional': 'medium',
  'qa-visual': 'medium',
  'qa-verdict': 'medium',
  'qa-fix': 'high',
  'quick-fix': 'medium',
  'code-review': 'medium',
  'ticket-review': 'high',
  'aar': 'medium',
  'polish': 'medium',
};

/**
 * One session request. The single shape shared by Spawner.run, runSequence
 * and runParallel (previously triplicated inline).
 */
export interface SpawnSessionOptions {
  /** Working directory */
  cwd: string;
  /** Full prompt text */
  prompt: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Session name for logging */
  sessionName?: string;
  /** File (relative to cwd) whose existence means the task succeeded */
  doneFile?: string;
  /** Model name, in the ACTIVE BACKEND's vocabulary */
  model?: string;
  /** Path to an MCP config JSON. Defaults to TURKEYCODE_MCP_CONFIG env var. */
  mcpConfig?: string;
  /** Reviewer session: no MCP servers at all, so it can't recall how the work was built. */
  blind?: boolean;
}
