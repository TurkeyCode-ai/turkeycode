import { describe, it, expect } from 'vitest';
import { createClaudeStreamCollector, createUsageCollector } from '../agents/usage';

// Event shapes as `claude --print --verbose --output-format stream-json`
// writes them, trimmed to the fields the collector reads.
const init = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' });
const assistant = (id: string, text: string, usage: Record<string, number>) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, model: 'claude-haiku-5-5', content: [{ type: 'text', text }], usage },
  });
const result = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'TURKEY',
    num_turns: 1,
    total_cost_usd: 0.00278732,
    usage: {
      input_tokens: 2,
      output_tokens: 7,
      cache_read_input_tokens: 11842,
      cache_creation_input_tokens: 13326,
    },
    modelUsage: {
      'claude-haiku-5-5': {
        inputTokens: 2,
        outputTokens: 7,
        cacheReadInputTokens: 11842,
        cacheCreationInputTokens: 13326,
        costUSD: 0.00278732,
      },
    },
    ...extra,
  });

function collect(lines: string[]) {
  const c = createClaudeStreamCollector();
  const shown = lines.map((l) => c.push(l));
  return { ...c.finish(), shown };
}

describe('claude stream collector', () => {
  it('reads reply text, tokens, turns and cost from the result event', () => {
    const out = collect([
      init,
      assistant('msg_1', 'TURKEY', { input_tokens: 2, output_tokens: 7 }),
      result(),
    ]);
    expect(out.text).toBe('TURKEY');
    expect(out.usage).toEqual({
      inputTokens: 2,
      outputTokens: 7,
      cacheReadTokens: 11842,
      cacheWriteTokens: 13326,
      costUsd: 0.00278732,
      turns: 1,
      complete: true,
    });
  });

  it('adds up every model in modelUsage, so subagent models are counted', () => {
    const out = collect([
      result({
        modelUsage: {
          a: { inputTokens: 1, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 1000 },
          b: { inputTokens: 2, outputTokens: 20, cacheReadInputTokens: 200, cacheCreationInputTokens: 2000 },
        },
      }),
    ]);
    expect(out.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 30,
      cacheReadTokens: 300,
      cacheWriteTokens: 3000,
      complete: true,
    });
  });

  it('falls back to the single usage block when modelUsage is absent', () => {
    const out = collect([result({ modelUsage: undefined })]);
    expect(out.usage).toMatchObject({ inputTokens: 2, outputTokens: 7, cacheReadTokens: 11842 });
  });

  it('a stream cut off before the result gives a lower bound, no cost and no reply text', () => {
    const out = collect([
      init,
      // The same message is emitted once per content block: count it once, at its largest.
      assistant('msg_1', 'working', { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 100 }),
      assistant('msg_1', 'working', { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 100 }),
      assistant('msg_2', 'more', { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 50 }),
    ]);
    expect(out.text).toBe('');
    expect(out.usage).toEqual({
      inputTokens: 6,
      outputTokens: 50,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      complete: false,
    });
    expect(out.usage?.costUsd).toBeUndefined();
  });

  it('an error result keeps its text, so limit wording is still visible to the caller', () => {
    const out = collect([
      result({ is_error: true, result: 'API Error: 429 rate_limit_error', total_cost_usd: 0 }),
    ]);
    expect(out.text).toBe('API Error: 429 rate_limit_error');
    expect(out.usage?.costUsd).toBe(0);
  });

  it('lines that are not events are kept as text and never throw', () => {
    const out = collect(['Error: not logged in', '{broken json', '', '[1,2,3]', '{"no":"type"}']);
    expect(out.text).toBe('Error: not logged in\n{broken json\n[1,2,3]\n{"no":"type"}');
    expect(out.usage).toBeUndefined();
    // Plain lines are returned as they came, which is how the spawner knows to scan them.
    expect(out.shown[0]).toBe('Error: not logged in');
  });

  it('shows assistant text and tool names for verbose mode, and nothing for other events', () => {
    const c = createClaudeStreamCollector();
    expect(c.push(init)).toBeNull();
    expect(
      c.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'm',
            content: [
              { type: 'text', text: 'Reading the spec' },
              { type: 'tool_use', name: 'Read', input: {} },
            ],
          },
        })
      )
    ).toBe('Reading the spec\n[tool: Read]');
    expect(c.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'rate limit exceeded' }] } }))).toBeNull();
  });

  it('an empty stream is empty text and no usage', () => {
    expect(collect([])).toMatchObject({ text: '' });
    expect(collect([]).usage).toBeUndefined();
  });
});

describe('createUsageCollector', () => {
  it('returns a collector only for a known format', () => {
    expect(createUsageCollector('claude-stream-json')).not.toBeNull();
    expect(createUsageCollector(undefined)).toBeNull();
  });
});
