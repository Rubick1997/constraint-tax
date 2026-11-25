import { Ajv } from "ajv";
import { buildRequest } from "./conditions.js";
import { classifyFirst, extractErrorMessage, is429 } from "./classify.js";
import { PROVIDER_LABEL } from "./providers.js";
import type { ChatResult, Condition, Provider, RequestRecord, SessionRecord, Task } from "./types.js";
import { sessionKey } from "./types.js";

export const MAX_TURNS = 4;
/** Waits before retry 1, 2, 3 of a rate-limited (429) request. */
export const RETRY_DELAYS_MS = [20_000, 40_000, 60_000];
export const MAX_RETRY_AFTER_MS = 60_000;
const ajv = new Ajv({ strict: false });

export interface Pricing {
  prompt: number;
  completion: number;
}

export interface SessionDeps {
  chat: (body: any) => Promise<ChatResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>; // used for 429 backoff; injectable for tests
  pricing?: Pricing; // fallback when response has no usage.cost
}

export function parseFinalJson(content: string): unknown | undefined {
  const trimmed = content.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const cand of [fenced, trimmed]) {
    try {
      return JSON.parse(cand);
    } catch {
      /* try next */
    }
  }
  const a = trimmed.indexOf("{");
  const b = trimmed.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(trimmed.slice(a, b + 1));
    } catch {
      /* fallthrough */
    }
  }
  return undefined;
}

function norm(v: unknown): unknown {
  return typeof v === "string" ? v.trim().toLowerCase() : v;
}

export function argsMatch(actual: any, expected: Record<string, string | number>): boolean {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, ev]) => {
    const av = actual[k];
    if (typeof ev === "number") return typeof av === "number" ? Math.abs(av - ev) <= 1e-6 : Math.abs(Number(av) - ev) <= 1e-6;
    return norm(av) === norm(ev);
  });
}

function requestCost(r: ChatResult, pricing?: Pricing): number | null {
  const u = r.json?.usage;
  if (typeof u?.cost === "number") return u.cost;
  if (pricing && u && typeof u.prompt_tokens === "number")
    return u.prompt_tokens * pricing.prompt + (u.completion_tokens ?? 0) * pricing.completion;
  return null;
}

function retryDelayMs(attempt: number, r: ChatResult): number {
  if (r.retryAfterSec && r.retryAfterSec > 0) return Math.min(r.retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_DELAYS_MS[attempt - 1]!;
}

function toRequestRecord(r: ChatResult, attempt: number, retryOf: number | null, provider: Provider, pricing?: Pricing): RequestRecord {
  const choice = r.json?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  return {
    status: r.status,
    latencyMs: r.latencyMs,
    finishReason: choice?.finish_reason ?? null,
    toolCallNames: Array.isArray(calls) ? calls.map((c: any) => c?.function?.name ?? "?") : [],
    usage: r.json?.usage ?? null,
    cost: requestCost(r, pricing),
    errorMessage: extractErrorMessage(r),
    providerName: PROVIDER_LABEL[provider] ?? (typeof r.json?.provider === "string" ? r.json.provider : null),
    retryAfterSec: r.retryAfterSec ?? null,
    rawStopReason: typeof choice?.rawStopReason === "string" ? choice.rawStopReason : null,
    attempt,
    retryOf,
    rateLimited: is429(r),
  };
}

export async function runSession(
  deps: SessionDeps,
  p: { model: string; condition: Condition; task: Task; rep: number; provider?: Provider; requireParameters?: boolean },
): Promise<SessionRecord> {
  const { model, condition, task, rep } = p;
  const provider: Provider = p.provider ?? "openrouter";
  // require_parameters is only ever sent to OpenRouter; record what was actually sent
  const requireParameters = provider === "openrouter" && p.requireParameters !== false;
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const toolNames = task.tools.map((t) => t.function.name);
  const messages: any[] = [
    { role: "system", content: task.system },
    { role: "user", content: task.user },
  ];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const requests: RequestRecord[] = [];
  let firstClass: ReturnType<typeof classifyFirst> | null = null;
  let toolCalled = false;
  let toolCorrect = false;
  let lastRes: ChatResult | null = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const body = buildRequest(model, task, condition, messages, turn, { provider, requireParameters });
    let res: ChatResult;
    let prevIdx: number | null = null;
    for (let attempt = 1; ; attempt++) {
      res = await deps.chat(body); // every attempt goes through the caller's rate limiter / quota
      const idx = requests.length;
      requests.push(toRequestRecord(res, attempt, prevIdx, provider, deps.pricing));
      if (!is429(res) || attempt > RETRY_DELAYS_MS.length) break;
      await sleep(retryDelayMs(attempt, res));
      prevIdx = idx;
    }
    lastRes = res;
    // after the loop `res` is the first non-429 response, or the last 429 if all attempts were limited
    if (turn === 1) firstClass = classifyFirst(res, toolNames);
    const msg = res.ok ? res.json?.choices?.[0]?.message : undefined;
    const calls: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0 || turn === MAX_TURNS) break;

    toolCalled = true;
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: calls,
      // Anthropic: raw content blocks (thinking included) so the adapter can replay the turn exactly
      ...(msg._anthropic_content ? { _anthropic_content: msg._anthropic_content } : {}),
    });
    for (const [i, c] of calls.entries()) {
      const name: string = c?.function?.name ?? "";
      let args: any;
      let out: unknown;
      try {
        args = JSON.parse(c?.function?.arguments ?? "{}");
      } catch {
        args = undefined;
      }
      if (name === task.expectedTool && argsMatch(args, task.expectedArgs)) toolCorrect = true;
      if (!(name in task.impl)) out = { error: "unknown tool" };
      else if (args === undefined || args === null || typeof args !== "object") out = { error: "invalid arguments" };
      else {
        try {
          out = task.impl[name]!(args);
        } catch {
          out = { error: "invalid arguments" };
        }
      }
      messages.push({ role: "tool", tool_call_id: c?.id ?? `call_${i}`, content: JSON.stringify(out) });
    }
  }
  if (requests[0] && requests[0].toolCallNames.length > 0) toolCalled = true;

  const finalMsg = lastRes?.ok ? lastRes.json?.choices?.[0]?.message : undefined;
  const finalContent: string = typeof finalMsg?.content === "string" ? finalMsg.content : "";
  const parsed = finalContent ? parseFinalJson(finalContent) : undefined;
  const finalJsonParsed = parsed !== undefined && parsed !== null && typeof parsed === "object";
  const schemaValid = finalJsonParsed && ajv.validate(task.schema.schema, parsed) === true;
  let answerCorrect = false;
  if (finalJsonParsed) {
    try {
      answerCorrect = task.checkAnswer(parsed) === true;
    } catch {
      answerCorrect = false;
    }
  }
  const e2eSuccess = condition === "schema-only" ? null : toolCorrect && schemaValid && answerCorrect;
  const superseded = new Set(requests.map((q) => q.retryOf).filter((x): x is number => typeof x === "number"));
  const errs = requests.filter((_, i) => !superseded.has(i)).map((q) => q.errorMessage).filter(Boolean);
  const fc = firstClass!;

  return {
    key: sessionKey(model, condition, task.id, rep),
    model,
    provider,
    requireParameters,
    condition,
    taskId: task.id,
    rep,
    startedAt,
    requests,
    firstOutcome: fc.outcome,
    toolCalled,
    toolCorrect,
    toolCallInText: fc.toolCallInText,
    finalJsonParsed,
    schemaValid,
    answerCorrect,
    e2eSuccess,
    rateLimitedAttempts: requests.filter((q) => q.rateLimited).length,
    totalLatencyMs: requests.reduce((s, q) => s + q.latencyMs, 0),
    totalCostUsd: requests.reduce((s, q) => s + (q.cost ?? 0), 0),
    finalContent: finalContent.slice(0, 2000),
    rawError: errs.length ? errs.join(" || ").slice(0, 1000) : null,
  };
}
