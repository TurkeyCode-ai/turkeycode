/**
 * OpenAI Codex CLI backend.
 *
 * `codex exec` is the print-mode analog of `claude --print`. The bypass flag
 * must be the full `--dangerously-bypass-approvals-and-sandbox` (aliased
 * `--yolo`), NOT `--full-auto`: full-auto keeps the workspace-write sandbox
 * with network disabled, and build sessions need `npm install`.
 */

import { AgentBackendSpec } from './types';

export const CODEX_BACKEND: AgentBackendSpec = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  baseArgs: [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
  ],
  // `codex exec -` reads the prompt from stdin; argv has an OS size limit and
  // turkeycode prompts (re-embedded transcripts, phase context) can be large.
  promptDelivery: 'stdin',
  stdinSentinelArg: '-',
  modelFlag: '-m',
  env: {
    apiKeyVar: 'OPENAI_API_KEY',
    // codex itself prefers the ChatGPT login when present; don't second-guess it.
    stripApiKeyByDefault: false,
  },
  versionArgs: ['--version'],
  installHint: 'npm install -g @openai/codex',
  setupHint: 'Run "codex login" once (ChatGPT account) or set OPENAI_API_KEY',
  billingHint:
    'Check your ChatGPT plan usage or OpenAI platform credits: https://platform.openai.com → Billing.',
  classifiers: {
    rateLimit: [
      'rate.?limit',
      '\\b429\\b',
      'too many requests',
    ],
    creditExhausted: [
      'insufficient_quota',
      'exceeded your current quota',
      'usage limit reached',
      'usage cap',
      'out of credit',
    ],
    apiErrorContext: [
      'rate.?limit',
      '\\b429\\b',
      'too many requests',
      'insufficient_quota',
      'openai',
      '\\bcodex\\b',
    ],
  },
  models: {
    // Codex model names drift fast — override with TURKEYCODE_MODEL(_PHASE)
    // or an agents.yaml entry when these age out.
    tiers: { high: 'gpt-5-codex', medium: 'gpt-5-codex', low: 'gpt-5-codex-mini' },
  },
  capabilities: {
    subagents: false,
    skills: false,
    // codex configures MCP in ~/.codex/config.toml, not a per-run flag.
    mcpConfig: false,
    multimodalImages: true,
  },
};
