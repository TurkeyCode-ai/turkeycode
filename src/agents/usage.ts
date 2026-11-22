/**
 * Token and cost accounting for one agent session.
 *
 * A backend that can report usage declares an `outputFormat` and the CLI
 * arguments that switch it on (`usageArgs`). The spawner feeds the session's
 * stdout through a collector line by line, so a long session never has to be
 * held in memory, and gets back the reply text plus what the session used.
 *
 * Parsing must never fail a session: a line that is not an event is kept as
 * plain text, and a stream with no usage in it simply reports none.
 */

/** What one session used, as far as the backend told us. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cost in US dollars as reported by the CLI. Absent when it never said. */
  costUsd?: number;
  /** Model turns, when the CLI reported them. */
  turns?: number;
  /**
   * True when the figures come from the CLI's own end-of-session total.
   * False when the session ended before that arrived (killed after its done
   * file, or timed out) and the figures were added up from the messages seen
   * so far: tokens are then a lower bound and there is no cost.
   */
  complete: boolean;
}

export interface CollectedOutput {
  /** What a plain `--print` run would have written to stdout. */
  text: string;
  usage?: SessionUsage;
}

export interface UsageCollector {
  /** Feed one complete line of stdout. Returns text worth showing in verbose mode. */
  push(line: string): string | null;
  finish(): CollectedOutput;
}

/** Output formats a backend can declare. */
export type AgentOutputFormat = 'claude-stream-json';

interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Collector for `claude --print --verbose --output-format stream-json`: one
 * JSON event per line, ending in a `result` event that carries the reply
 * text, the session totals and the cost.
 */
export function createClaudeStreamCollector(): UsageCollector {
  const plainLines: string[] = [];
  // Per message id, the largest figures seen: a message is emitted once per
  // content block, each time with its usage so far.
  const byMessage = new Map<string, MessageUsage>();
  let result: Record<string, unknown> | null = null;

  return {
    push(line: string): string | null {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let event: Record<string, unknown> | null = null;
      if (trimmed.startsWith('{')) {
        try {
          event = asRecord(JSON.parse(trimmed));
        } catch {
          event = null;
        }
      }
      if (!event || typeof event.type !== 'string') {
        // Not an event (a CLI error printed as plain text, for example).
        plainLines.push(line);
        return line;
      }

      if (event.type === 'result') {
        result = event;
        return null;
      }

      if (event.type === 'assistant') {
        const message = asRecord(event.message);
        if (!message) return null;
        const usage = asRecord(message.usage);
        if (usage && typeof message.id === 'string') {
          const prev = byMessage.get(message.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          byMessage.set(message.id, {
            input: Math.max(prev.input, num(usage.input_tokens)),
            output: Math.max(prev.output, num(usage.output_tokens)),
            cacheRead: Math.max(prev.cacheRead, num(usage.cache_read_input_tokens)),
            cacheWrite: Math.max(prev.cacheWrite, num(usage.cache_creation_input_tokens)),
          });
        }
        // Verbose display: the assistant's words and the names of tools it calls.
        const shown: string[] = [];
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = asRecord(block);
            if (!b) continue;
            if (b.type === 'text' && typeof b.text === 'string') shown.push(b.text);
            if (b.type === 'tool_use' && typeof b.name === 'string') shown.push(`[tool: ${b.name}]`);
          }
        }
        return shown.length ? shown.join('\n') : null;
      }

      return null;
    },

    finish(): CollectedOutput {
      const plain = plainLines.join('\n');
      if (result) {
        const replyText = typeof result.result === 'string' ? result.result : '';
        const text = [plain, replyText].filter((s) => s.length > 0).join('\n');
        // modelUsage covers every model the session touched (subagents
        // included); fall back to the single usage block.
        const totals: MessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const modelUsage = asRecord(result.modelUsage);
        const models = modelUsage ? Object.values(modelUsage).map(asRecord).filter(Boolean) : [];
        if (models.length > 0) {
          for (const m of models) {
            totals.input += num(m!.inputTokens);
            totals.output += num(m!.outputTokens);
            totals.cacheRead += num(m!.cacheReadInputTokens);
            totals.cacheWrite += num(m!.cacheCreationInputTokens);
          }
        } else {
          const usage = asRecord(result.usage);
          if (usage) {
            totals.input = num(usage.input_tokens);
            totals.output = num(usage.output_tokens);
            totals.cacheRead = num(usage.cache_read_input_tokens);
            totals.cacheWrite = num(usage.cache_creation_input_tokens);
          }
        }
        const usage: SessionUsage = {
          inputTokens: totals.input,
          outputTokens: totals.output,
          cacheReadTokens: totals.cacheRead,
          cacheWriteTokens: totals.cacheWrite,
          complete: true,
        };
        if (typeof result.total_cost_usd === 'number') usage.costUsd = result.total_cost_usd;
        if (typeof result.num_turns === 'number') usage.turns = result.num_turns;
        return { text, usage };
      }

      // No end-of-session total. A plain --print run prints its reply only at
      // the end, so there is no reply text either; report what the messages
      // seen so far add up to.
      if (byMessage.size === 0) return { text: plain };
      const usage: SessionUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        complete: false,
      };
      for (const m of byMessage.values()) {
        usage.inputTokens += m.input;
        usage.outputTokens += m.output;
        usage.cacheReadTokens += m.cacheRead;
        usage.cacheWriteTokens += m.cacheWrite;
      }
      return { text: plain, usage };
    },
  };
}

/** The collector for a backend's declared output format, or null for plain text. */
export function createUsageCollector(format: AgentOutputFormat | undefined): UsageCollector | null {
  if (format === 'claude-stream-json') return createClaudeStreamCollector();
  return null;
}
