/**
 * OpenCode backend.
 *
 * `opencode run` is non-interactive and takes the prompt as its message
 * argument; `--auto` approves permission requests that aren't explicitly
 * denied. Models are provider-scoped (`-m provider/model`), and which
 * providers exist depends entirely on the user's opencode config — so no
 * tier table here: without TURKEYCODE_MODEL(_PHASE) or an agents.yaml
 * override, sessions run on the user's configured opencode default model.
 */

import { AgentBackendSpec, HTTP_429_PATTERN } from './types';

export const OPENCODE_BACKEND: AgentBackendSpec = {
  id: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  baseArgs: ['run', '--auto'],
  promptDelivery: 'arg',
  modelFlag: '-m',
  env: {
    // Provider keys depend on the user's opencode config; pass everything
    // through (secrets are still stripped by the global NEVER_PASS_VARS).
  },
  versionArgs: ['--version'],
  installHint: 'npm install -g opencode-ai   (or: brew install anomaly/tap/opencode)',
  setupHint: 'Run "opencode auth login" once to configure a provider',
  billingHint: 'Check the billing/quota page of the provider configured in opencode.',
  classifiers: {
    rateLimit: [
      'rate.?limit',
      HTTP_429_PATTERN,
      'too many requests',
    ],
    creditExhausted: [
      'insufficient credit',
      'quota exceeded',
      'exceeded your current quota',
      'usage limit reached',
      'out of credit',
    ],
    apiErrorContext: [
      'rate.?limit',
      HTTP_429_PATTERN,
      'too many requests',
      'rate_limit_error',
      'insufficient_quota',
      'RESOURCE_EXHAUSTED',
    ],
  },
  models: {
    tiers: {},
  },
  capabilities: {
    subagents: false,
    skills: false,
    mcpConfig: false,
    multimodalImages: false,
  },
};
