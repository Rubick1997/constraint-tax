import { withToolsAndSchema, type ChatFn } from "../../packages/tool-schema-safe/src/index.js";
import type { Client } from "../client.js";
import { SYSTEM } from "../tasks/helpers.js";
import { runBrainWorker, type Plan, type StepResult } from "./brain-worker.js";
import { HAIKU, Meter, SONNET, PRICES, costUsd, parseUsage } from "./meter.js";
import { checkFields, demoToolDefs, makeExecutor, type DemoTask } from "./tasks.js";

export const DEFAULT_WORKERS = ["lfm3:1.7b", "gemma4:26b-a4b"];
export const WORKER_TEMPERATURE = 0;
/** Output budget for Claude calls; leaves room for default thinking. */
export const CLAUDE_MAX_TOKENS = 8000;
export const SOLO_MAX_TURNS = 10;

export type ArmKind = "sonnet-solo" | "haiku-solo" | "worker-solo" | "brain-worker";
export interface Arm {
  name: string;
  kind: ArmKind;
  workerModel?: string;
}
export const usesClaude = (a: Arm) => a.kind !== "worker-solo";

export function parseArms(spec: string): Arm[] {
  const out: Arm[] = [];
  const add = (a: Arm) => out.some((x) => x.name === a.name) || out.push(a);
  const items = spec === "all" ? ["sonnet-solo", "haiku-solo", "worker-solo", "brain-worker"] : spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    const i = item.indexOf(":");
    const kind = (i < 0 ? item : item.slice(0, i)) as ArmKind;
    const model = i < 0 ? undefined : item.slice(i + 1);
    if (kind === "sonnet-solo" || kind === "haiku-solo") {
      if (model) throw new Error(`${kind} takes no model`);
      add({ name: kind, kind });
    } else if (kind === "worker-solo" || kind === "brain-worker") {
      for (const m of model ? [model] : DEFAULT_WORKERS) add({ name: `${kind}:${m}`, kind, workerModel: m });
    } else throw new Error(`unknown arm ${item}`);
  }
  if (!out.length) throw new Error("no arms selected");
  return out;
}

export interface DemoRecord {
  key: string;
  arm: string;
  task: string;
  kind: "chain" | "bulky";
  rep: number;
  startedAt: string;
  correct: boolean;
  fieldScore: number;
  claudeCalls: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheReadTokens: number;
  claudeCacheWriteTokens: number;
  claudeCostUsd: number;
  claudeLatencyMs: number;
  workerCalls: number;
  workerLatencyMs: number;
  toolCalls: number;
  totalLatencyMs: number;
  workerModel: string | null;
  workerTemperature: number | null;
  plan: Plan | null;
  stepResults: StepResult[] | null;
  rerunUsed: boolean;
  error: string | null;
  /** True when the error looks like a network/rate-limit/server problem; resume retries these. */
  transient: boolean;
  finalAnswer: unknown | null;
}

export const demoKey = (arm: string, task: string, rep: number) => `${arm}|${task}|${rep}`;
export const isTransientError = (e: string | null) => !!e && /HTTP (0|408|429|5\d\d)\b|network error|timeout|fetch failed|ECONN/i.test(e);

export interface ArmDeps {
  claude: Client;
  ollama: Client;
  now: () => number;
  /** Called before every Claude request; may throw to stop (spend cap). */
  guard?: () => void;
  /** Called with the cost of every Claude response, so the runner can track spend even for failed sessions. */
  onClaudeCost?: (usd: number) => void;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** ChatFn over a Client that meters usage; Claude calls are priced, the local worker is free. */
export function meteredChat(client: Client, meter: Meter, o: { extraBody?: Record<string, unknown>; guard?: () => void; onCost?: (usd: number) => void } = {}): ChatFn {
  return async (body) => {
    o.guard?.();
    const res = await client.chat({ ...(o.extraBody ?? {}), ...body });
    const u = parseUsage(res.json?.usage);
    const model = String(body.model ?? "");
    const cost = PRICES[model] ? costUsd(model, u) : 0;
    meter.add(u, cost, res.latencyMs);
    if (cost) o.onCost?.(cost);
    if (!res.ok) throw new HttpError(res.status, res.json?.error?.message ?? res.errorMessage ?? `HTTP ${res.status}`);
    if (res.json?.error) throw new HttpError(Number(res.json.error.code) || 502, String(res.json.error.message ?? "error in 200 body"));
    return res.json;
  };
}

export async function runArm(arm: Arm, task: DemoTask, rep: number, deps: ArmDeps): Promise<DemoRecord> {
  const t0 = deps.now();
  const claude = new Meter();
  const worker = new Meter();
  let toolCalls = 0;
  const exec = makeExecutor(() => void toolCalls++);
  const tools = demoToolDefs(task);
  const claudeChat = meteredChat(deps.claude, claude, { extraBody: { max_tokens: CLAUDE_MAX_TOKENS }, guard: deps.guard, onCost: deps.onClaudeCost });
  const workerChat = meteredChat(deps.ollama, worker, { extraBody: { temperature: WORKER_TEMPERATURE } });

  let answer: unknown | null = null;
  let error: string | null = null;
  let plan: Plan | null = null;
  let stepResults: StepResult[] | null = null;
  let rerunUsed = false;
  try {
    if (arm.kind === "sonnet-solo" || arm.kind === "haiku-solo" || arm.kind === "worker-solo") {
      const claudeArm = arm.kind !== "worker-solo";
      const r = await withToolsAndSchema(claudeArm ? claudeChat : workerChat, {
        model: arm.kind === "sonnet-solo" ? SONNET : arm.kind === "haiku-solo" ? HAIKU : arm.workerModel!,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }],
        tools,
        schema: task.schema.schema,
        schemaName: task.schema.name,
        executeTool: exec,
        // Claude: tools + native structured output work together (no forced tool_choice is ever sent).
        // Local worker: native silently drops tools, so the schema becomes a submit_answer function.
        strategy: claudeArm ? "native" : "answer-as-tool",
        maxTurns: SOLO_MAX_TURNS,
      });
      answer = r.answer;
      error = r.error ?? (r.validated ? null : `schema: ${(r.validationErrors ?? ["no answer"]).join("; ")}`);
    } else {
      const out = await runBrainWorker({
        prompt: task.prompt,
        tools,
        schema: task.schema.schema,
        schemaName: task.schema.name,
        brain: claudeChat,
        brainModel: SONNET,
        worker: workerChat,
        workerModel: arm.workerModel!,
        executeTool: exec,
        workerExtraBody: { temperature: WORKER_TEMPERATURE },
      });
      answer = out.answer;
      error = out.error ?? null;
      plan = out.plan;
      stepResults = out.stepResults;
      rerunUsed = out.rerunUsed;
    }
  } catch (e: any) {
    error = `${typeof e?.status === "number" ? `HTTP ${e.status}: ` : ""}${e?.message ?? String(e)}`;
  }
  const chk = checkFields(task, answer);
  return {
    key: demoKey(arm.name, task.id, rep),
    arm: arm.name,
    task: task.id,
    kind: task.kind,
    rep,
    startedAt: new Date(t0).toISOString(),
    correct: chk.correct,
    fieldScore: chk.fieldScore,
    claudeCalls: claude.calls,
    claudeInputTokens: claude.inputTokens,
    claudeOutputTokens: claude.outputTokens,
    claudeCacheReadTokens: claude.cacheReadTokens,
    claudeCacheWriteTokens: claude.cacheWriteTokens,
    claudeCostUsd: claude.costUsd,
    claudeLatencyMs: claude.latencyMs,
    workerCalls: worker.calls,
    workerLatencyMs: worker.latencyMs,
    toolCalls,
    totalLatencyMs: deps.now() - t0,
    workerModel: arm.workerModel ?? null,
    workerTemperature: arm.workerModel ? WORKER_TEMPERATURE : null,
    plan,
    stepResults,
    rerunUsed,
    error,
    transient: isTransientError(error),
    finalAnswer: answer,
  };
}
