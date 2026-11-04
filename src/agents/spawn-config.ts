/**
 * Pure functions that turn an AgentBackendSpec + session options into the
 * argv/env a session is spawned with, plus the output classifiers.
 * Pure so tests can lock the exact vectors without spawning anything.
 */

import { AgentBackendSpec, PHASE_TIERS } from './types';

/**
 * Secrets that must never reach a session, regardless of backend. Backend
 * quirks (nested-session guards, API-key policy) come from the spec.
 */
export const NEVER_PASS_VARS = [
  'DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY', 'NEXTAUTH_SECRET', 'SESSION_SECRET',
];

/**
 * Build the full argv for one session.
 * `mcpConfig` must already be validated (file exists, backend supports it).
 * When promptDelivery is 'arg' the prompt itself lands in the argv; for
 * 'stdin' the caller writes it to the child's stdin.
 */
export function buildAgentArgs(
  spec: AgentBackendSpec,
  options: { model?: string; mcpConfig?: string; prompt?: string; blind?: boolean }
): string[] {
  const args = [...spec.baseArgs];

  if (options.model && spec.modelFlag) {
    args.push(spec.modelFlag, options.model);
  }

  if (options.blind) {
    args.push(...(spec.blindFlags ?? []));
  } else if (options.mcpConfig && spec.mcpConfigFlag) {
    args.push(spec.mcpConfigFlag, options.mcpConfig);
  }

  if (spec.promptDelivery === 'arg') {
    if (spec.promptFlag) args.push(spec.promptFlag);
    args.push(options.prompt ?? '');
  } else if (spec.stdinSentinelArg) {
    args.push(spec.stdinSentinelArg);
  }

  return args;
}

/**
 * Build the child env for one session: inherit process.env, strip secrets and
 * backend nested-session guards, apply the API-key policy, force CI mode.
 */
export function buildAgentEnv(
  spec: AgentBackendSpec,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const cleanEnv = { ...baseEnv };

  const stripVars = [...NEVER_PASS_VARS, ...(spec.env.nestedGuardVars ?? [])];
  // By default strip the vendor key so the CLI uses its login session. In
  // headless / API-key mode (no login session — e.g. CI) set
  // TURKEYCODE_USE_API_KEY=1 to KEEP the key as the auth source.
  if (
    spec.env.apiKeyVar &&
    spec.env.stripApiKeyByDefault &&
    baseEnv.TURKEYCODE_USE_API_KEY !== '1'
  ) {
    stripVars.push(spec.env.apiKeyVar);
  }
  for (const key of stripVars) {
    delete cleanEnv[key];
  }

  cleanEnv.CI = 'true'; // Prevent interactive prompts
  return cleanEnv;
}

/** Compiled classifier sets, cached per spec object. */
interface CompiledClassifiers {
  rateLimit: RegExp[];
  creditExhausted: RegExp[];
  apiErrorContext: RegExp[];
}

const classifierCache = new WeakMap<AgentBackendSpec, CompiledClassifiers>();

function getClassifiers(spec: AgentBackendSpec): CompiledClassifiers {
  let compiled = classifierCache.get(spec);
  if (!compiled) {
    compiled = {
      rateLimit: spec.classifiers.rateLimit.map(s => new RegExp(s, 'i')),
      creditExhausted: spec.classifiers.creditExhausted.map(s => new RegExp(s, 'i')),
      apiErrorContext: spec.classifiers.apiErrorContext.map(s => new RegExp(s, 'i')),
    };
    classifierCache.set(spec, compiled);
  }
  return compiled;
}

/**
 * Classify a chunk of CLI output for rate-limit signals. Credit exhaustion is
 * only declared when credit/usage wording co-occurs with an actual API-error
 * marker — otherwise application-domain text (e.g. a banking app's
 * "insufficient credit") would false-trip it and the orchestrator would fail
 * the build for a non-existent rate limit.
 */
export function detectAgentSignals(
  spec: AgentBackendSpec,
  text: string
): { rateLimited: boolean; creditExhausted: boolean } {
  const c = getClassifiers(spec);
  const hasApiContext = c.apiErrorContext.some(p => p.test(text));
  const hasCreditWording = c.creditExhausted.some(p => p.test(text));
  const creditExhausted = hasCreditWording && hasApiContext;
  const rateLimited = creditExhausted || c.rateLimit.some(p => p.test(text));
  return { rateLimited, creditExhausted };
}

/**
 * Resolve the model for a phase against a backend.
 * Precedence: TURKEYCODE_MODEL_<PHASE> env (qa-fix -> TURKEYCODE_MODEL_QA_FIX)
 * > TURKEYCODE_MODEL > spec phase pin > spec tier table > undefined (CLI
 * default model, no flag). Env values are in the ACTIVE backend's vocabulary —
 * running out of credit on ONE model must not mean editing source mid-build.
 */
export function resolveModelForPhase(
  spec: AgentBackendSpec,
  phase: string
): string | undefined {
  const key = 'TURKEYCODE_MODEL_' + phase.toUpperCase().replace(/-/g, '_');
  const perPhase = process.env[key];
  if (perPhase) return perPhase;

  const global = process.env.TURKEYCODE_MODEL;
  if (global) return global;

  const pinned = spec.models.phaseOverrides?.[phase];
  if (pinned) return pinned;

  const tier = PHASE_TIERS[phase];
  return tier ? spec.models.tiers[tier] : undefined;
}
