import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MODEL_IDS,
  message,
  classify,
  estimateCostUsd,
  setClient,
  type CachedContext,
} from '../api';

// Minimal fake of the SDK client. Captures the last params passed to messages.create.
function makeFakeClient(text: string, usage?: Partial<any>) {
  const captured: { params?: any } = {};
  const client = {
    messages: {
      create: async (params: any) => {
        captured.params = params;
        return {
          content: [{ type: 'text', text }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            ...usage,
          },
        };
      },
    },
  };
  return { client: client as any, captured };
}

const ctx: CachedContext = {
  system: 'You are a QA verdict classifier.',
  spec: 'Build a todo app with auth.',
  techContext: 'Stack: Express + React + Postgres',
};

afterEach(() => setClient(null));

describe('api module', () => {
  it('maps tiers to exact model IDs (no date suffixes)', () => {
    expect(MODEL_IDS.opus).toBe('claude-opus-4-8');
    expect(MODEL_IDS.sonnet).toBe('claude-sonnet-4-6');
    expect(MODEL_IDS.haiku).toBe('claude-haiku-4-5');
  });

  it('puts the cache breakpoint on the last system block and the prompt in the user turn', async () => {
    const { client, captured } = makeFakeClient('ok');
    setClient(client);

    await message({ context: ctx, prompt: 'Is this CLEAN?' });

    const sys = captured.params.system;
    // system is an array of text blocks
    expect(Array.isArray(sys)).toBe(true);
    expect(sys.length).toBe(3); // system + spec + techContext
    // only the LAST block carries cache_control
    expect(sys[0].cache_control).toBeUndefined();
    expect(sys[1].cache_control).toBeUndefined();
    expect(sys[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // the volatile prompt is in the user turn, after the cached prefix
    expect(captured.params.messages).toEqual([{ role: 'user', content: 'Is this CLEAN?' }]);
  });

  it('honors a 5m cache TTL when requested', async () => {
    const { client, captured } = makeFakeClient('ok');
    setClient(client);
    await message({ context: ctx, prompt: 'q', cacheTtl: '5m' });
    const sys = captured.params.system;
    expect(sys[sys.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('drops effort for Haiku (it 400s there) but keeps it for Sonnet/Opus', async () => {
    const haiku = makeFakeClient('ok');
    setClient(haiku.client);
    await message({ model: 'haiku', context: ctx, prompt: 'q', effort: 'high' });
    expect(haiku.captured.params.output_config?.effort).toBeUndefined();

    const opus = makeFakeClient('ok');
    setClient(opus.client);
    await message({ model: 'opus', context: ctx, prompt: 'q', effort: 'high' });
    expect(opus.captured.params.output_config?.effort).toBe('high');
  });

  it('defaults thinking off and enables adaptive only when asked', async () => {
    const off = makeFakeClient('ok');
    setClient(off.client);
    await message({ context: ctx, prompt: 'q' });
    expect(off.captured.params.thinking).toBeUndefined();

    const on = makeFakeClient('ok');
    setClient(on.client);
    await message({ context: ctx, prompt: 'q', thinking: 'adaptive' });
    expect(on.captured.params.thinking).toEqual({ type: 'adaptive' });
  });

  it('classify() wires the JSON schema and parses the response', async () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    const { client, captured } = makeFakeClient('{"verdict":"CLEAN"}');
    setClient(client);

    const out = await classify<{ verdict: string }>({ context: ctx, prompt: 'verdict?', schema });

    expect(captured.params.output_config.format).toEqual({ type: 'json_schema', schema });
    expect(out.value.verdict).toBe('CLEAN');
  });

  it('classify() throws a helpful error on non-JSON output', async () => {
    const { client } = makeFakeClient('not json at all');
    setClient(client);
    await expect(
      classify({ context: ctx, prompt: 'q', schema: { type: 'object' } })
    ).rejects.toThrow(/did not return valid JSON/);
  });

  it('reports usage including cache reads', async () => {
    const { client } = makeFakeClient('ok', { cache_read_input_tokens: 5000, input_tokens: 20 });
    setClient(client);
    const out = await message({ context: ctx, prompt: 'q' });
    expect(out.usage.cacheRead).toBe(5000);
    expect(out.usage.input).toBe(20);
  });

  it('estimateCostUsd prices cache reads at 0.1x input and output at the model rate', () => {
    // Sonnet: input $3/MTok, output $15/MTok. 1M cache-read input = $0.30; 1M output = $15.
    const cost = estimateCostUsd('sonnet', { input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 1_000_000 });
    expect(cost).toBeCloseTo(0.3 + 15, 5);
  });

  it('estimateCostUsd charges 2x for a 1h cache write vs 1.25x for 5m', () => {
    const usage = { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 0 };
    const oneHour = estimateCostUsd('opus', usage, '1h'); // 1M * $5 * 2 = $10
    const fiveMin = estimateCostUsd('opus', usage, '5m'); // 1M * $5 * 1.25 = $6.25
    expect(oneHour).toBeCloseTo(10, 5);
    expect(fiveMin).toBeCloseTo(6.25, 5);
  });
});
