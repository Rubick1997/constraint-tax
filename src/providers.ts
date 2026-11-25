import Anthropic from "@anthropic-ai/sdk";
import { createClient, type Client, type FetchLike } from "./client.js";
import type { ChatResult, Provider } from "./types.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const OLLAMA_TIMEOUT_MS = 600_000;
export const ANTHROPIC_MAX_TOKENS = 4096;

export const providerOf = (m: { provider?: Provider }): Provider => m.provider ?? "openrouter";

export const PROVIDER_LABEL: Record<Provider, string | null> = {
  openrouter: null, // taken from the response body (`provider`)
  anthropic: "Anthropic",
  ollama: "Ollama",
};

export function createOllamaClient(opts: { fetch?: FetchLike; baseUrl?: string; timeoutMs?: number } = {}): Client {
  return createClient({
    fetch: opts.fetch,
    baseUrl: opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL,
    timeoutMs: opts.timeoutMs ?? OLLAMA_TIMEOUT_MS,
    requireKey: false,
  });
}

// ---------------------------------------------------------------- Anthropic

/** The slice of the SDK client we use; tests inject a mock. */
export interface AnthropicLike {
  messages: { create(params: any): Promise<any> };
}

const STOP_REASON: Record<string, string> = {
  tool_use: "tool_calls",
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  refusal: "content_filter",
};

/** Canonical (OpenAI chat-completions shaped) request body -> Anthropic Messages params. */
export function toAnthropicRequest(body: any): any {
  const system: string[] = [];
  const messages: any[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === "system") {
      system.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      let content: any[];
      if (Array.isArray(m._anthropic_content)) {
        content = m._anthropic_content; // replay verbatim, thinking blocks included
      } else {
        content = [];
        if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
        for (const c of m.tool_calls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(c.function?.arguments ?? "{}");
          } catch {
            /* keep {} */
          }
          content.push({ type: "tool_use", id: c.id, name: c.function?.name, input });
        }
      }
      messages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    }
  }
  const params: any = { model: body.model, max_tokens: body.max_tokens ?? ANTHROPIC_MAX_TOKENS, messages };
  if (system.length) params.system = system.join("\n\n");
  if (body.tools?.length)
    params.tools = body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  if (body.response_format?.type === "json_schema")
    params.output_config = { format: { type: "json_schema", schema: body.response_format.json_schema.schema } };
  if (body.tool_choice === "required") params.tool_choice = { type: "any" };
  // temperature is deliberately never sent: Haiku 5.5 rejects non-default sampling. `thinking` is left unset.
  return params;
}

/** Anthropic Message -> canonical chat-completions JSON. */
export function fromAnthropicResponse(msg: any): any {
  const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const tool_calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = msg?.usage ?? {};
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const message: any = { role: "assistant", content: text || null, _anthropic_content: blocks };
  if (tool_calls.length) message.tool_calls = tool_calls;
  const raw: string | null = msg?.stop_reason ?? null;
  return {
    id: msg?.id,
    model: msg?.model,
    provider: "Anthropic",
    choices: [{ index: 0, message, finish_reason: raw ? (STOP_REASON[raw] ?? raw) : null, rawStopReason: raw }],
    usage: { prompt_tokens: promptTokens, completion_tokens: u.output_tokens ?? 0, raw: u },
  };
}

function errorResult(status: number, message: string, t0: number, retryAfterSec?: number, errorMessage?: string): ChatResult {
  const json = { error: { message } };
  if (status === 0) errorMessage ??= `network error: ${message}`;
  return { ok: false, status, json, rawText: JSON.stringify(json), latencyMs: Date.now() - t0, retryAfterSec, errorMessage };
}

export function createAnthropicClient(opts: { sdk?: AnthropicLike; timeoutMs?: number } = {}): Client {
  let sdk = opts.sdk;
  const getSdk = (): AnthropicLike => (sdk ??= new Anthropic({ maxRetries: 0, timeout: opts.timeoutMs ?? 120_000 }) as unknown as AnthropicLike);
  return {
    async chat(body: any): Promise<ChatResult> {
      const t0 = Date.now();
      try {
        const msg = await getSdk().messages.create(toAnthropicRequest(body));
        const json = fromAnthropicResponse(msg);
        return { ok: true, status: 200, json, rawText: "", latencyMs: Date.now() - t0 };
      } catch (e: any) {
        const message = String(e?.apiMessage ?? e?.error?.error?.message ?? e?.message ?? e);
        if (e instanceof Anthropic.RateLimitError) {
          const ra = Number(e.headers?.get?.("retry-after"));
          return errorResult(429, message, t0, Number.isFinite(ra) && ra > 0 ? ra : undefined);
        }
        if (e instanceof Anthropic.BadRequestError) return errorResult(400, message, t0);
        if (e instanceof Anthropic.APIConnectionError) return errorResult(0, message, t0, undefined, `network error: ${message}`);
        if (e instanceof Anthropic.APIError) return errorResult(typeof e.status === "number" ? e.status : 0, message, t0);
        return errorResult(0, message, t0, undefined, `network error: ${message}`);
      }
    },
    async getKeyInfo() {
      return {};
    },
  };
}
