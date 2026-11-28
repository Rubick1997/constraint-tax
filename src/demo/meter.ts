// Usage metering and cost math for the demo.

/** USD per million tokens. Sonnet 5.5 and Haiku 5.5 prices apply to prompts of at most 100K tokens. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
/** Prompt-cache multipliers relative to the input price (5-minute cache write, cache read). */
export const CACHE_WRITE_MULT = 1.25;
export const CACHE_READ_MULT = 0.1;

export interface Usage {
  inputTokens: number; // total prompt tokens, including cache reads and writes
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Normalises a response `usage` block (Anthropic raw via the adapter, or OpenAI shaped). */
export function parseUsage(u: any): Usage {
  const raw = u?.raw;
  if (raw) {
    const cr = raw.cache_read_input_tokens ?? 0;
    const cw = raw.cache_creation_input_tokens ?? 0;
    return { inputTokens: (raw.input_tokens ?? 0) + cr + cw, outputTokens: raw.output_tokens ?? 0, cacheReadTokens: cr, cacheWriteTokens: cw };
  }
  return { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for model ${model}`);
  const plain = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
  return (plain * p.input + u.cacheWriteTokens * p.input * CACHE_WRITE_MULT + u.cacheReadTokens * p.input * CACHE_READ_MULT + u.outputTokens * p.output) / 1e6;
}

export class Meter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  costUsd = 0;
  latencyMs = 0;
  add(u: Usage, cost: number, latencyMs: number) {
    this.calls++;
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    this.cacheReadTokens += u.cacheReadTokens;
    this.cacheWriteTokens += u.cacheWriteTokens;
    this.costUsd += cost;
    this.latencyMs += latencyMs;
  }
}
