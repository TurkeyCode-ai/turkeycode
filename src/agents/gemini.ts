/**
 * Gemini CLI backend.
 *
 * Piped stdin puts gemini in headless mode with stdin as the prompt (`-p` is
 * the argv alternative; stdin avoids the OS argv size limit for turkeycode's
 * large prompts). `--yolo` auto-approves all tool calls (the equivalent of
 * `--approval-mode yolo`).
 */

import { AgentBackendSpec, HTTP_429_PATTERN } from './types';

export const GEMINI_BACKEND: AgentBackendSpec = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  baseArgs: ['--yolo'],
  promptDelivery: 'stdin',
  modelFlag: '-m',
  env: {
    apiKeyVar: 'GEMINI_API_KEY',
    // gemini handles login (OAuth) vs API key itself; pass the key through.
    stripApiKeyByDefault: false,
  },
  versionArgs: ['--version'],
  installHint: 'npm install -g @google/gemini-cli',
  setupHint: 'Run "gemini" once to log in with Google, or set GEMINI_API_KEY',
  billingHint:
    'Check your Gemini API quota in Google AI Studio (https://aistudio.google.com) or your Google Cloud billing.',
  classifiers: {
    rateLimit: [
      'rate.?limit',
      HTTP_429_PATTERN,
      'too many requests',
      'RESOURCE_EXHAUSTED',
    ],
    creditExhausted: [
      'quota exceeded',
      'exceeded your current quota',
      'usage limit reached',
      'out of credit',
    ],
    apiErrorContext: [
      'rate.?limit',
      HTTP_429_PATTERN,
      'too many requests',
      'RESOURCE_EXHAUSTED',
      'googleapis',
      'gemini',
    ],
  },
  models: {
    // Gemini model names drift — override with TURKEYCODE_MODEL(_PHASE) or
    // agents.yaml when these age out.
    tiers: { high: 'gemini-2.5-pro', medium: 'gemini-2.5-pro', low: 'gemini-2.5-flash' },
  },
  capabilities: {
    subagents: false,
    skills: false,
    // gemini configures MCP in settings.json, not a per-run flag.
    mcpConfig: false,
    multimodalImages: true,
  },
};
