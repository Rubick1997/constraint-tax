import { withToolsAndSchema, SUBMIT_ANSWER, type ChatFn } from "../packages/tool-schema-safe/src/index.js";
import { classifyFirst, extractErrorMessage, is429 } from "./classify.js";
import { RETRY_DELAYS_MS, argsMatch, retryDelayMs, toRequestRecord, type SessionDeps } from "./session.js";
import type { ChatResult, Provider, RequestRecord, SessionRecord, Task, WorkaroundCondition } from "./types.js";
import { sessionKey } from "./types.js";

const STRATEGY: Record<WorkaroundCondition, "two-phase" | "answer-as-tool"> = {
  "wa-two-phase": "two-phase",
  "wa-answer-as-tool": "answer-as-tool",
};

/** Thrown into the package by the adapter for non-OK results; carries `status` like the package expects. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Runs one workaround session. `deps.chat` is the runner's wrapped chat (quota, rate limit, spend guard):
 * every underlying request, including 429 retries, goes through it and counts.
 */
export async function runWorkaroundSession(
  deps: SessionDeps,
  p: { model: string; condition: WorkaroundCondition; task: Task; rep: number; provider?: Provider; requireParameters?: boolean },
): Promise<SessionRecord> {
  const { model, condition, task, rep } = p;
  const provider: Provider = p.provider ?? "openrouter";
  const requireParameters = provider === "openrouter" && p.requireParameters !== false;
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const requests: RequestRecord[] = [];
  let firstLogical: ChatResult | null = null;
  let firstDone = false;
  let fatal: unknown;

  const chat: ChatFn = async (body) => {
    let res!: ChatResult;
    let prevIdx: number | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await deps.chat(body); // each attempt is a real request for quota purposes
      } catch (e) {
        fatal = e; // StopRun etc.: surfaced after the package returns
        throw e;
      }
      const idx = requests.length;
      requests.push(toRequestRecord(res, attempt, prevIdx, provider, deps.pricing));
      if (!is429(res) || attempt > RETRY_DELAYS_MS.length) break;
      await sleep(retryDelayMs(attempt, res));
      prevIdx = idx;
    }
    if (!firstDone) {
      firstDone = true;
      firstLogical = res;
    }
    if (!res.ok) throw new HttpError(res.status, extractErrorMessage(res) ?? `HTTP ${res.status}`);
    if (res.json?.error) {
      const code = Number(res.json.error.code);
      throw new HttpError(Number.isFinite(code) && code >= 100 ? code : 502, extractErrorMessage(res) ?? "error in 200 body");
    }
    return res.json;
  };

  const extraBody: Record<string, unknown> = { temperature: 0.5, max_tokens: 4096 };
  if (provider === "openrouter") {
    if (requireParameters) extraBody.provider = { require_parameters: true };
    extraBody.usage = { include: true };
  }

  const r = await withToolsAndSchema(chat, {
    model,
    messages: [
      { role: "system", content: task.system },
      { role: "user", content: task.user },
    ],
    tools: task.tools,
    schema: task.schema.schema,
    schemaName: task.schema.name,
    executeTool: (name, args) => {
      if (!(name in task.impl)) return { error: "unknown tool" };
      if (args === undefined || args === null || typeof args !== "object") return { error: "invalid arguments" };
      try {
        return task.impl[name]!(args);
      } catch {
        return { error: "invalid arguments" };
      }
    },
    strategy: STRATEGY[condition],
    extraBody,
  });
  if (fatal) throw fatal;

  const toolNames = task.tools.map((t) => t.function.name);
  const fc = firstLogical ? classifyFirst(firstLogical, toolNames) : { outcome: "error_or_refusal" as const, toolCallInText: false, message: null };
  // A first turn that only called submit_answer made no real tool call.
  let outcome = fc.outcome;
  const first = requests.find((q) => !q.rateLimited) ?? requests[0];
  if (outcome === "tool_called" && first && first.toolCallNames.every((n) => n === SUBMIT_ANSWER)) outcome = "tool_missing";

  const toolCalled = r.toolCalls.length > 0;
  const toolCorrect = r.toolCalls.some((c) => c.name === task.expectedTool && argsMatch(c.args, task.expectedArgs));
  const answered = r.answer !== null && typeof r.answer === "object";
  const schemaValid = r.validated;
  let answerCorrect = false;
  if (answered) {
    try {
      answerCorrect = task.checkAnswer(r.answer) === true;
    } catch {
      answerCorrect = false;
    }
  }
  const superseded = new Set(requests.map((q) => q.retryOf).filter((x): x is number => typeof x === "number"));
  const errs = requests.filter((_, i) => !superseded.has(i)).map((q) => q.errorMessage).filter(Boolean);
  if (r.error && !errs.length) errs.push(r.error);

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
    firstOutcome: outcome,
    toolCalled,
    toolCorrect,
    toolCallInText: fc.toolCallInText,
    finalJsonParsed: answered,
    schemaValid,
    answerCorrect,
    e2eSuccess: toolCorrect && schemaValid && answerCorrect,
    rateLimitedAttempts: requests.filter((q) => q.rateLimited).length,
    totalLatencyMs: requests.reduce((s, q) => s + q.latencyMs, 0),
    totalCostUsd: requests.reduce((s, q) => s + (q.cost ?? 0), 0),
    finalContent: answered ? JSON.stringify(r.answer).slice(0, 2000) : "",
    rawError: errs.length ? errs.join(" || ").slice(0, 1000) : null,
  };
}
