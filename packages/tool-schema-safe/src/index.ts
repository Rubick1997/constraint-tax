import { Ajv } from "ajv";

// ------------------------------------------------------------------ types

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: object };
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  [k: string]: unknown;
}

/** One OpenAI chat.completions request in, the response JSON out. Must throw (error with `status`) on non-2xx. */
export type ChatFn = (body: Record<string, unknown>) => Promise<any>;

export type Strategy = "native" | "two-phase" | "answer-as-tool" | "auto";

export interface Options {
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  schema: object;
  schemaName?: string;
  executeTool: (name: string, args: unknown) => Promise<unknown> | unknown;
  strategy: Strategy;
  /** Max rounds of tool execution (default 4). */
  maxTurns?: number;
  /** Merged into every request body (temperature, provider, ...). */
  extraBody?: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: unknown;
}

export interface Result {
  toolCalls: ToolCallRecord[];
  answer: unknown | null;
  validated: boolean;
  validationErrors?: string[];
  /** Number of chat requests sent, including failed ones and a failed native attempt before a fallback. */
  calls: number;
  latencyMs: number;
  strategyUsed: string;
  fellBack?: boolean;
  error?: string;
}

export const SUBMIT_ANSWER = "submit_answer";
export const DEFAULT_MAX_TURNS = 4;

// ------------------------------------------------------------------ auto memory

export type NativeStatus = "native-ok" | "native-broken";
const memory = new Map<string, NativeStatus>();

/** Clears the per-model memory used by strategy "auto" (for tests). */
export function resetAutoMemory(): void {
  memory.clear();
}
/** Read-only peek at what "auto" has learned about a model. */
export function getAutoStatus(model: string): NativeStatus | undefined {
  return memory.get(model);
}

// ------------------------------------------------------------------ helpers

const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new WeakMap<object, ReturnType<Ajv["compile"]>>();

export function validateAnswer(schema: object, answer: unknown): { valid: boolean; errors?: string[] } {
  if (answer === null || answer === undefined) return { valid: false, errors: ["no answer"] };
  try {
    let v = validators.get(schema);
    if (!v) validators.set(schema, (v = ajv.compile(schema)));
    if (v(answer)) return { valid: true };
    return { valid: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`) };
  } catch (e: any) {
    return { valid: false, errors: [`schema error: ${e?.message ?? String(e)}`] };
  }
}

/** Parses JSON from model text: plain, inside ``` fences, or the outermost {...}/[...]. */
export function parseJsonLoose(text: unknown): unknown | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t) return undefined;
  const fenced = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const cand of [fenced, t]) {
    try {
      return JSON.parse(cand);
    } catch {
      /* next */
    }
  }
  for (const [o, c] of [["{", "}"], ["[", "]"]] as const) {
    const a = t.indexOf(o);
    const b = t.lastIndexOf(c);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

const statusOf = (e: any): number | undefined => (typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : undefined);
const msgOf = (e: any): string => String(e?.message ?? e);

interface Ctx {
  chat: ChatFn;
  o: Options;
  maxTurns: number;
  calls: number;
  toolCalls: ToolCallRecord[];
  /** native only: did the first response contain a tool call? undefined until known. */
  firstTurnToolCalled?: boolean;
}

async function send(ctx: Ctx, body: Record<string, unknown>): Promise<any> {
  ctx.calls++;
  const res = await ctx.chat({ ...(ctx.o.extraBody ?? {}), ...body });
  const choice = res?.choices?.[0];
  if (!choice) {
    const err: any = new Error(`no choices in response${res?.error ? `: ${JSON.stringify(res.error).slice(0, 300)}` : ""}`);
    if (typeof res?.error?.code === "number") err.status = res.error.code;
    throw err;
  }
  return choice.message ?? {};
}

const toolCallsOf = (msg: any): any[] => (Array.isArray(msg?.tool_calls) ? msg.tool_calls : []);

async function runTool(ctx: Ctx, c: any, i: number): Promise<{ id: string; content: string }> {
  const name: string = c?.function?.name ?? "";
  let args: unknown;
  let result: unknown;
  let parsed = true;
  try {
    const raw = c?.function?.arguments;
    args = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {});
  } catch {
    parsed = false;
  }
  if (!parsed) result = { error: "invalid arguments" };
  else {
    try {
      result = await ctx.o.executeTool(name, args);
    } catch (e: any) {
      result = { error: msgOf(e) };
    }
  }
  ctx.toolCalls.push({ name, args: parsed ? args : undefined, result });
  return { id: c?.id ?? `call_${i}`, content: typeof result === "string" ? result : (JSON.stringify(result ?? null) ?? "null") };
}

/** Appends the assistant message (verbatim, so provider-specific fields survive) and one tool message per call. */
async function applyToolCalls(ctx: Ctx, messages: ChatMessage[], msg: any, calls: any[], skip?: (c: any) => boolean): Promise<void> {
  messages.push({ ...msg, role: "assistant", content: msg.content ?? null, tool_calls: calls });
  for (const [i, c] of calls.entries()) {
    if (skip?.(c)) {
      messages.push({ role: "tool", tool_call_id: c?.id ?? `call_${i}`, content: "ok" });
      continue;
    }
    const r = await runTool(ctx, c, i);
    messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}

const responseFormat = (o: Options) => ({
  type: "json_schema",
  json_schema: { name: o.schemaName ?? "answer", strict: true, schema: o.schema },
});

/** Tool loop. Returns the final non-tool message (or the last tool-calling one if maxTurns ran out) and whether it still wanted tools. */
async function toolLoop(
  ctx: Ctx,
  messages: ChatMessage[],
  tools: ToolDef[],
  extra: Record<string, unknown>,
  isTerminal?: (calls: any[]) => boolean,
  trackFirst = false,
): Promise<{ msg: any; pendingCalls: any[] }> {
  for (let round = 0; ; round++) {
    const msg = await send(ctx, { model: ctx.o.model, messages, ...(tools.length ? { tools } : {}), ...extra });
    const calls = toolCallsOf(msg);
    if (trackFirst && round === 0) ctx.firstTurnToolCalled = calls.length > 0;
    if (calls.length === 0) return { msg, pendingCalls: [] };
    if (isTerminal?.(calls)) return { msg, pendingCalls: calls };
    if (round >= ctx.maxTurns) return { msg, pendingCalls: calls };
    await applyToolCalls(ctx, messages, msg, calls);
  }
}

type Outcome = { answer: unknown | null; error?: string };

// ------------------------------------------------------------------ strategies

async function runNative(ctx: Ctx): Promise<Outcome> {
  const messages = [...ctx.o.messages];
  const { msg, pendingCalls } = await toolLoop(ctx, messages, ctx.o.tools, { response_format: responseFormat(ctx.o) }, undefined, true);
  if (pendingCalls.length) return { answer: null, error: `maxTurns (${ctx.maxTurns}) exhausted while the model was still calling tools` };
  const answer = parseJsonLoose(msg.content);
  return answer === undefined ? { answer: null, error: "final content was not valid JSON" } : { answer };
}

async function runTwoPhase(ctx: Ctx): Promise<Outcome> {
  const messages = [...ctx.o.messages];
  // Phase 1: tools, no response_format.
  const { msg, pendingCalls } = await toolLoop(ctx, messages, ctx.o.tools, {});
  // The phase-1 plain-text reply is KEPT in the context (it often holds useful reasoning), unless it is empty or
  // the model was still asking for tools when maxTurns ran out (an unanswered tool_calls message is invalid).
  if (!pendingCalls.length && typeof msg.content === "string" && msg.content.trim()) messages.push({ role: "assistant", content: msg.content });
  messages.push({
    role: "user",
    content: "Using the tool results above, now reply with only the final answer as a single JSON object matching the required schema. No other text.",
  });
  // Phase 2: response_format, NO tools, NO tool_choice.
  const final = await send(ctx, { model: ctx.o.model, messages, response_format: responseFormat(ctx.o) });
  const answer = parseJsonLoose(final.content);
  return answer === undefined ? { answer: null, error: "phase-2 content was not valid JSON" } : { answer };
}

const ADDENDUM = `When you have everything you need, finish by calling the ${SUBMIT_ANSWER} function with the final answer. Do not write the answer as plain text.`;
const NUDGE = `Please finish now by calling the ${SUBMIT_ANSWER} function with your final answer.`;

async function runAnswerAsTool(ctx: Ctx): Promise<Outcome> {
  const submit: ToolDef = {
    type: "function",
    function: { name: SUBMIT_ANSWER, description: "Submit the final answer. Call this once, when you are done.", parameters: ctx.o.schema },
  };
  const tools = [...ctx.o.tools, submit];
  const messages: ChatMessage[] = [...ctx.o.messages];
  if (messages[0]?.role === "system" && typeof messages[0].content === "string") messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${ADDENDUM}` };
  else messages.unshift({ role: "system", content: ADDENDUM });

  const isSubmit = (c: any) => c?.function?.name === SUBMIT_ANSWER;
  let nudged = false;
  for (;;) {
    const { msg, pendingCalls } = await toolLoop(ctx, messages, tools, {}, (calls) => calls.some(isSubmit));
    const submit = pendingCalls.find(isSubmit);
    if (submit) {
      // Run any real tools requested alongside (for the record) but do not execute submit_answer.
      for (const [i, c] of pendingCalls.entries()) if (!isSubmit(c)) await runTool(ctx, c, i);
      const raw = submit.function?.arguments;
      let args: unknown;
      try {
        args = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        args = undefined;
      }
      if (args !== undefined && args !== null) return { answer: args };
      if (nudged) return { answer: null, error: `${SUBMIT_ANSWER} arguments were not valid JSON` };
    } else if (pendingCalls.length) {
      return { answer: null, error: `maxTurns (${ctx.maxTurns}) exhausted while the model was still calling tools` };
    } else if (nudged) {
      const last = parseJsonLoose(msg.content);
      return last === undefined ? { answer: null, error: `model never called ${SUBMIT_ANSWER} and its text was not JSON` } : { answer: last };
    }
    // Plain text (or unusable submit) with no answer yet: nudge once.
    messages.push({ ...msg, role: "assistant", content: msg.content ?? "" , ...(submit ? { tool_calls: pendingCalls } : {}) });
    if (submit) for (const [i, c] of pendingCalls.entries()) messages.push({ role: "tool", tool_call_id: c?.id ?? `call_${i}`, content: isSubmit(c) ? "error: arguments were not valid JSON" : "ok" });
    messages.push({ role: "user", content: NUDGE });
    nudged = true;
  }
}

// ------------------------------------------------------------------ entry point

export async function withToolsAndSchema(chat: ChatFn, o: Options): Promise<Result> {
  const t0 = Date.now();
  const ctx: Ctx = { chat, o, maxTurns: o.maxTurns ?? DEFAULT_MAX_TURNS, calls: 0, toolCalls: [] };
  let strategyUsed: string = o.strategy;
  let fellBack = false;
  let out: Outcome;

  const run = (s: "native" | "two-phase" | "answer-as-tool") => (s === "native" ? runNative(ctx) : s === "two-phase" ? runTwoPhase(ctx) : runAnswerAsTool(ctx));

  try {
    if (o.strategy !== "auto") out = await run(o.strategy);
    else {
      const known = memory.get(o.model);
      if (known === "native-broken") {
        strategyUsed = "answer-as-tool";
        out = await run("answer-as-tool");
      } else {
        strategyUsed = "native";
        let broken = false;
        out = { answer: null };
        try {
          out = await run("native");
          if (o.tools.length > 0 && ctx.firstTurnToolCalled === false) broken = true; // silent drop
        } catch (e: any) {
          const s = statusOf(e);
          // 4xx (except 408/429, which say nothing about capability) = the endpoint rejects the combination.
          if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) broken = true;
          else throw e;
        }
        if (broken) {
          memory.set(o.model, "native-broken");
          fellBack = true;
          // answer-as-tool, not two-phase: it needs only tool support, while two-phase's
          // second call needs response_format, which some tool-capable endpoints lack.
          strategyUsed = "answer-as-tool";
          ctx.toolCalls = [];
          out = await run("answer-as-tool");
        } else if (o.tools.length > 0 && ctx.firstTurnToolCalled === true) memory.set(o.model, "native-ok");
      }
    }
  } catch (e: any) {
    out = { answer: null, error: `${statusOf(e) !== undefined ? `HTTP ${statusOf(e)}: ` : ""}${msgOf(e)}` };
  }

  const v = validateAnswer(o.schema, out.answer);
  const result: Result = {
    toolCalls: ctx.toolCalls,
    answer: out.answer,
    validated: v.valid,
    calls: ctx.calls,
    latencyMs: Date.now() - t0,
    strategyUsed,
  };
  if (!v.valid && out.answer !== null) result.validationErrors = v.errors;
  if (fellBack) result.fellBack = true;
  if (out.error) result.error = out.error;
  return result;
}
