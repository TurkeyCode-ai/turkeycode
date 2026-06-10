/**
 * Direct Anthropic SDK client for turkeycode — for the SHORT, STRUCTURED calls
 * (QA verdict classification, triage, summarization), not the agentic build/QA
 * sessions (those stay on the `claude` CLI in spawner.ts, which has tools + auto-caching).
 *
 * Why this exists: every one of these structured calls re-sends the same large,
 * stable prefix — the system instruction + project spec + tech context. Putting a
 * `cache_control` breakpoint at the end of that prefix means the first call writes
 * it (~1.25x/2x input) and every later call within the TTL reads it at ~0.1x. Across
 * a run that's a big cut on the repeated-prefix tokens. See `shared/prompt-caching.md`
 * (claude-api skill) for the prefix-match invariant this relies on.
 *
 * Caching invariant: the cached prefix must be byte-identical across calls. Build it
 * once per run (CachedContext) and keep `model` + `context` stable to get hits — the
 * per-call question goes in the user turn, AFTER the breakpoint, so it never
 * invalidates the cache. Verify hits via `usage.cacheRead > 0` on repeated calls.
 *
 * Models: Opus 4.8 / Sonnet 4.6 / Haiku 4.5. Adaptive thinking only (Opus 4.8 400s on
 * budget_tokens). `effort` is rejected by Haiku 4.5, so it's dropped for that tier.
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Models ──────────────────────────────────────────────────────────────────

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Exact model IDs — do NOT append date suffixes (they 404). */
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/** `effort` is GA on Opus 4.x and Sonnet 4.6 but 400s on Haiku 4.5. */
const EFFORT_CAPABLE: Record<ModelTier, boolean> = { haiku: false, sonnet: true, opus: true };

/** Per-MTok USD rates (input / output). cache write = 1.25x (5m) or 2x (1h) input; cache read = 0.1x input. */
const RATES: Record<ModelTier, { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

// ── Client (lazy singleton) ──────────────────────────────────────────────────

let _client: Anthropic | null = null;

/** Lazily construct the SDK client. Resolves ANTHROPIC_API_KEY from the env. */
export function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error('ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is required for direct API calls');
    }
    _client = new Anthropic();
  }
  return _client;
}

/** Test seam: inject a client (e.g. a mock). */
export function setClient(client: Anthropic | null): void {
  _client = client;
}

// ── Cached context ────────────────────────────────────────────────────────────

export type CacheTtl = '5m' | '1h';

/**
 * The stable, cacheable prefix shared across many structured calls in a run.
 * Assemble once; pass to every call. Keep the field values byte-stable across the
 * run or the cache invalidates (see module header).
 */
export interface CachedContext {
  /** Frozen system instruction (role/persona/output rules). */
  system: string;
  /** The project spec — large and stable across the run. */
  spec?: string;
  /** Tech context (stack / entities / endpoints / pages) — stable across the run. */
  techContext?: string;
}

/**
 * Render the cached prefix as system text blocks with ONE breakpoint on the last
 * block — a single breakpoint caches every preceding block too (prefix match).
 * 1h TTL by default: turkeycode phases run 60–90 min, so 5m would expire between
 * calls and never get read; 1h costs 2x to write but survives the gaps.
 */
function buildSystemBlocks(ctx: CachedContext, ttl: CacheTtl): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: ctx.system }];
  if (ctx.spec) blocks.push({ type: 'text', text: `# PROJECT SPEC\n\n${ctx.spec}` });
  if (ctx.techContext) blocks.push({ type: 'text', text: `# TECH CONTEXT\n\n${ctx.techContext}` });

  // Breakpoint on the final stable block → caches the whole prefix.
  const last = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral', ttl } };
  return blocks;
}

// ── Shared param builder ──────────────────────────────────────────────────────

export interface CallOptions {
  /** Model tier. Default 'sonnet'. */
  model?: ModelTier;
  /** The cached, stable prefix. */
  context: CachedContext;
  /** The per-call question — goes in the user turn, after the cache breakpoint. */
  prompt: string;
  /** Max output tokens. Default 4096. */
  maxTokens?: number;
  /** Adaptive thinking or off. Default 'disabled' (structured classification doesn't need it). */
  thinking?: 'adaptive' | 'disabled';
  /** Effort level — silently dropped on Haiku (it 400s there). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Cache TTL for the prefix. Default '1h'. */
  cacheTtl?: CacheTtl;
  /** JSON schema — when set, constrains output to valid JSON matching it. */
  schema?: Record<string, unknown>;
}

function buildParams(opts: CallOptions): { tier: ModelTier; params: Anthropic.MessageCreateParamsNonStreaming } {
  const tier = opts.model ?? 'sonnet';
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: MODEL_IDS[tier],
    max_tokens: opts.maxTokens ?? 4096,
    system: buildSystemBlocks(opts.context, opts.cacheTtl ?? '1h'),
    messages: [{ role: 'user', content: opts.prompt }],
  };

  if (opts.thinking === 'adaptive') params.thinking = { type: 'adaptive' };

  const output_config: Anthropic.Messages.OutputConfig = {};
  if (opts.effort && EFFORT_CAPABLE[tier]) output_config.effort = opts.effort;
  if (opts.schema) output_config.format = { type: 'json_schema', schema: opts.schema };
  if (output_config.effort || output_config.format) params.output_config = output_config;

  return { tier, params };
}

// ── Usage / cost ──────────────────────────────────────────────────────────────

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

function extractUsage(msg: Anthropic.Message): Usage {
  return {
    input: msg.usage.input_tokens,
    output: msg.usage.output_tokens,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
  };
}

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Estimate the USD cost of a call from its usage. cacheRead is billed at 0.1x input,
 * cacheWrite at ~1.25x (5m) or 2x (1h) — we use 1.25x as a conservative floor since
 * the breakpoint TTL isn't on the usage object.
 */
export function estimateCostUsd(model: ModelTier, usage: Usage, cacheTtl: CacheTtl = '1h'): number {
  const rate = RATES[model];
  const writeMult = cacheTtl === '1h' ? 2 : 1.25;
  const inputUsd = (usage.input * rate.input + usage.cacheWrite * rate.input * writeMult + usage.cacheRead * rate.input * 0.1) / 1_000_000;
  const outputUsd = (usage.output * rate.output) / 1_000_000;
  return inputUsd + outputUsd;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MessageResult {
  text: string;
  usage: Usage;
  model: ModelTier;
  raw: Anthropic.Message;
}

/** One structured call against the cached prefix. Returns the text response + usage. */
export async function message(opts: CallOptions): Promise<MessageResult> {
  const { tier, params } = buildParams(opts);
  const raw = await getClient().messages.create(params);
  return { text: extractText(raw), usage: extractUsage(raw), model: tier, raw };
}

export interface ClassifyResult<T> {
  value: T;
  usage: Usage;
  model: ModelTier;
  raw: Anthropic.Message;
}

/**
 * Structured classification against the cached prefix. `schema` constrains the
 * output to valid JSON, so the response parses cleanly into T. Ideal for the QA
 * verdict (CLEAN/NEEDS_FIX + issues) and ticket triage.
 */
export async function classify<T>(opts: CallOptions & { schema: Record<string, unknown> }): Promise<ClassifyResult<T>> {
  const { tier, params } = buildParams({ maxTokens: 2048, ...opts });
  const raw = await getClient().messages.create(params);
  const text = extractText(raw);
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`classify(): model did not return valid JSON: ${text.slice(0, 300)}`);
  }
  return { value, usage: extractUsage(raw), model: tier, raw };
}

// ── Batch (50% off, for the QA fan-out) ───────────────────────────────────────

export interface BatchItem {
  /** Stable id you use to match the result back. */
  id: string;
  /** Per-item call options (each can use the same cached context). */
  call: CallOptions;
}

export interface BatchResult {
  id: string;
  text: string | null;
  usage: Usage | null;
  /** 'succeeded' | 'errored' | 'expired' | 'canceled'. */
  status: string;
  error?: string;
}

/**
 * Run a set of structured calls through the Batch API at 50% of standard price,
 * then poll to completion. Each item shares its own cached prefix, so within a
 * batch the common context is written once and read by the rest.
 *
 * Trade-off: batches are NOT latency-sensitive — most finish within an hour but
 * may take up to 24h. Use for cost on the QA fan-out when you can tolerate the
 * wait; use message()/classify() when you need the answer now.
 */
export async function batch(
  items: BatchItem[],
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<BatchResult[]> {
  if (items.length === 0) return [];
  const client = getClient();
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;

  const created = await client.messages.batches.create({
    requests: items.map(item => ({
      custom_id: item.id,
      params: buildParams(item.call).params,
    })),
  });

  const start = Date.now();
  let status = created.processing_status;
  while (status !== 'ended') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`batch ${created.id} did not finish within ${timeoutMs}ms (status: ${status})`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const polled = await client.messages.batches.retrieve(created.id);
    status = polled.processing_status;
  }

  const results: BatchResult[] = [];
  for await (const r of await client.messages.batches.results(created.id)) {
    if (r.result.type === 'succeeded') {
      results.push({
        id: r.custom_id,
        text: extractText(r.result.message),
        usage: extractUsage(r.result.message),
        status: 'succeeded',
      });
    } else {
      results.push({
        id: r.custom_id,
        text: null,
        usage: null,
        status: r.result.type,
        error: r.result.type === 'errored' ? JSON.stringify(r.result.error) : undefined,
      });
    }
  }
  return results;
}
