/**
 * Claude Code — the reference backend. Everything here is the behavior
 * turkeycode always had, extracted verbatim into spec form.
 */

import { AgentBackendSpec } from './types';

export const CLAUDE_BACKEND: AgentBackendSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  baseArgs: [
    '--print',
    '--dangerously-skip-permissions',
    '--verbose',
    '--input-format', 'text',
  ],
  promptDelivery: 'stdin',
  modelFlag: '--model',
  mcpConfigFlag: '--mcp-config',
  blindFlags: ['--strict-mcp-config'],
  env: {
    apiKeyVar: 'ANTHROPIC_API_KEY',
    // Default to the Max/Pro login session in ~/.claude; TURKEYCODE_USE_API_KEY=1
    // keeps the key for headless/CI environments with no login session.
    stripApiKeyByDefault: true,
    // Prevent "nested session" error when turkeycode itself runs inside Claude Code.
    nestedGuardVars: ['CLAUDECODE'],
  },
  versionArgs: ['--version'],
  installHint: 'npm install -g @anthropic-ai/claude-code',
  setupHint: 'Run "claude" once to log in (or set ANTHROPIC_API_KEY with TURKEYCODE_USE_API_KEY=1)',
  billingHint:
    'Check your Claude subscription or Console credits: https://console.anthropic.com → Settings → Billing. ' +
    'On a Max/Pro plan, enable "extra usage" or wait for the limit to reset.',
  classifiers: {
    rateLimit: [
      'rate.?limit',
      '\\b429\\b',
      'too many requests',
    ],
    creditExhausted: [
      // Deliberately omits bare "balance"/"funds"/"billing cycle"/"monthly" —
      // ordinary app-domain words. These only fire alongside apiErrorContext.
      'credit balance is too low',
      'insufficient credit',
      'out of credit',
      'credit[^.\\n]{0,30}exhaust',
      'usage limit reached',
      'monthly credit',
      'extra usage',
      'purchase (more )?credit',
    ],
    apiErrorContext: [
      'rate.?limit',
      '\\b429\\b',
      'too many requests',
      'rate_limit_error',
      'x-ratelimit',
      'anthropic',
    ],
  },
  models: {
    // Bare aliases float to the latest model in each tier
    // (currently Opus 5 / Sonnet 5 / Haiku 4.5).
    tiers: { high: 'opus', medium: 'sonnet', low: 'haiku' },
    phaseOverrides: {
      // Fable 5: Anthropic's most capable model, built for exactly this shape
      // of work (long-horizon agentic coding, 60-90 min sessions,
      // self-verification). The build session is where quality is won or
      // lost; blocker debugging is the hardest task in the run.
      'build': 'claude-fable-5',
      'qa-fix': 'claude-fable-5',
    },
  },
  capabilities: {
    subagents: true,
    skills: true,
    mcpConfig: true,
    multimodalImages: true,
  },
};
