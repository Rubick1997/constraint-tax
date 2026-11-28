import { parseJsonLoose, validateAnswer, withToolsAndSchema, type ChatFn } from "../../packages/tool-schema-safe/src/index.js";
import type { ToolDef } from "../types.js";

export interface PlanStep {
  id: string;
  instruction: string;
  tools: string[];
  output_schema: object;
}
export interface Plan {
  steps: PlanStep[];
}
export interface StepResult {
  id: string;
  /** Instruction text as executed (placeholders substituted). */
  instruction: string;
  answer: unknown | null;
  validated: boolean;
  error?: string;
  workerCalls: number;
  toolCalls: number;
  reran?: boolean;
}

export interface BrainWorkerInput {
  prompt: string;
  tools: ToolDef[];
  schema: object;
  schemaName?: string;
  brain: ChatFn;
  brainModel: string;
  worker: ChatFn;
  workerModel: string;
  executeTool: (name: string, args: unknown) => unknown;
  /** Max tool rounds per worker step (default 6). */
  workerMaxTurns?: number;
  workerExtraBody?: Record<string, unknown>;
}
export interface BrainWorkerOutput {
  answer: unknown | null;
  plan: Plan | null;
  stepResults: StepResult[];
  rerunUsed: boolean;
  rerunStepId?: string;
  error?: string;
}

export const MAX_STEPS = 8;
const MAX_STEP_RESULT_CHARS = 4000;

// ------------------------------------------------------------------ prompts and wire schemas

export const PLAN_SYSTEM = `You are the planner (the brain) in a brain/worker setup. A weaker worker model will execute your plan with tools. You never see raw tool outputs, only the structured result of each step, so plan accordingly.

Split the task into a few small, self-contained steps. Rules:
- Step ids are s1, s2, ... in execution order.
- "instruction" is plain text addressed to the worker. It must be fully self-contained: include every concrete value the worker needs (IDs, names, thresholds, rounding rules). To use an earlier step's result, write {{s1}} (the step id in double braces); the harness replaces it with that step's result as compact JSON.
- "tools" lists the names of the tools that step needs, taken only from the tool list. Give each step as few tools as possible.
- "output_schema_json" is a JSON string holding the JSON Schema of that step's result: an object whose properties are all required, with additionalProperties false, using only string, number, integer, boolean or arrays of those.
- When a tool may return a large payload, tell the worker to do the filtering, counting or aggregation itself and to return only the compact result, never the raw rows.
- Keep each step to about three tool calls or fewer. Do the final arithmetic, comparison and rounding in the later synthesis, not in the plan.`;

export const SYNTH_SYSTEM = `You are the brain in a brain/worker setup. You receive the task, the plan, and the structured result of each executed step (not the raw tool outputs). Produce the final answer in the required schema, using only the step results; do any remaining arithmetic or rounding yourself and follow the rounding rules in the task.

If a step result is missing, null, or inconsistent with the task, set rerun_step_id to that step's id to have the worker run it once more; this is allowed once in total. Otherwise set rerun_step_id to "none". Always also fill "answer" with your best answer.`;

export const WORKER_SYSTEM =
  "You are a careful tool-using worker. Use the provided tools to do exactly what the instruction says; never guess values. When tools return long lists, do the filtering and counting yourself, carefully. Finish by submitting the result in the requested format.";

export const planWireSchema = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          instruction: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          output_schema_json: { type: "string" },
        },
        required: ["id", "instruction", "tools", "output_schema_json"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
};

export function wrapperSchema(answerSchema: object, stepIds: string[]) {
  return {
    type: "object",
    properties: { rerun_step_id: { type: "string", enum: [...new Set([...stepIds, "none"])] }, answer: answerSchema },
    required: ["rerun_step_id", "answer"],
    additionalProperties: false,
  };
}

// ------------------------------------------------------------------ helpers

const compact = (v: unknown) => JSON.stringify(v ?? null);

export function toolSpecsText(tools: ToolDef[]): string {
  return JSON.stringify(tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })));
}

/** Replaces {{id}} with the compact JSON of that step's result; unknown ids are left as they are. */
export function substitute(instruction: string, results: Map<string, unknown>): string {
  return instruction.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (m, id: string) => (results.has(id) ? compact(results.get(id)) : m));
}

/** Makes a model-written step schema strict: object at the top, all properties required, no extra properties. */
export function normalizeStepSchema(raw: unknown): object {
  const fallback = { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false };
  const parsed = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const fix = (s: any): any => {
    if (!s || typeof s !== "object") return s;
    if (Array.isArray(s)) return s.map(fix);
    const out: any = { ...s };
    if (out.properties && typeof out.properties === "object") {
      out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, fix(v)]));
      out.type = "object";
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    if (out.items) out.items = fix(out.items);
    return out;
  };
  const s: any = fix(parsed);
  return s && typeof s === "object" && s.type === "object" && s.properties && Object.keys(s.properties).length ? s : fallback;
}

/** Validates the wire plan and turns it into an executable one. */
export function parsePlan(data: unknown, toolNames: string[]): { plan?: Plan; error?: string } {
  const steps = (data as any)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { error: "plan has no steps" };
  if (steps.length > MAX_STEPS) return { error: `plan has ${steps.length} steps (max ${MAX_STEPS})` };
  const ids = new Set<string>();
  const out: PlanStep[] = [];
  for (const s of steps) {
    if (typeof s?.id !== "string" || !s.id.trim() || ids.has(s.id)) return { error: `plan step id missing or duplicated: ${JSON.stringify(s?.id)}` };
    if (typeof s.instruction !== "string" || !s.instruction.trim()) return { error: `plan step ${s.id} has no instruction` };
    ids.add(s.id);
    out.push({
      id: s.id,
      instruction: s.instruction,
      tools: (Array.isArray(s.tools) ? s.tools : []).filter((t: unknown): t is string => typeof t === "string" && toolNames.includes(t)),
      output_schema: normalizeStepSchema(s.output_schema_json ?? s.output_schema),
    });
  }
  return { plan: { steps: out } };
}

async function brainCall(chat: ChatFn, model: string, system: string, user: string, name: string, schema: object): Promise<{ data?: any; error?: string }> {
  const res = await chat({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  });
  const msg = res?.choices?.[0]?.message;
  const data = parseJsonLoose(msg?.content);
  return data === undefined ? { error: `${name}: response was not valid JSON (finish ${res?.choices?.[0]?.finish_reason ?? "?"})` } : { data };
}

// ------------------------------------------------------------------ orchestration

export async function runBrainWorker(i: BrainWorkerInput): Promise<BrainWorkerOutput> {
  const toolNames = i.tools.map((t) => t.function.name);
  const base: BrainWorkerOutput = { answer: null, plan: null, stepResults: [], rerunUsed: false };

  // 1. Plan (no tool output ever reaches the brain).
  const planCall = await brainCall(i.brain, i.brainModel, PLAN_SYSTEM, `TASK:\n${i.prompt}\n\nAVAILABLE TOOLS (name, description, parameters):\n${toolSpecsText(i.tools)}`, "plan", planWireSchema);
  if (planCall.error) return { ...base, error: planCall.error };
  const parsed = parsePlan(planCall.data, toolNames);
  if (!parsed.plan) return { ...base, error: `plan: ${parsed.error}` };
  const plan = parsed.plan;
  base.plan = plan;

  // 2. Execute each step on the worker.
  const results = new Map<string, unknown>();
  const stepResults: StepResult[] = [];
  const runStep = async (step: PlanStep): Promise<StepResult> => {
    const instruction = substitute(step.instruction, results);
    const toolDefs = i.tools.filter((t) => step.tools.includes(t.function.name));
    const r = await withToolsAndSchema(i.worker, {
      model: i.workerModel,
      messages: [{ role: "system", content: WORKER_SYSTEM }, { role: "user", content: instruction }],
      tools: toolDefs,
      schema: step.output_schema,
      schemaName: `step_${step.id}`,
      executeTool: (n, a) => (step.tools.includes(n) ? i.executeTool(n, a) : { error: `tool ${n} is not available in this step` }),
      strategy: "answer-as-tool",
      maxTurns: i.workerMaxTurns ?? 6,
      extraBody: i.workerExtraBody,
    });
    return { id: step.id, instruction, answer: r.validated ? r.answer : null, validated: r.validated, error: r.error ?? (r.validated ? undefined : (r.validationErrors ?? ["invalid result"]).join("; ")), workerCalls: r.calls, toolCalls: r.toolCalls.length };
  };
  for (const step of plan.steps) {
    const sr = await runStep(step);
    stepResults.push(sr);
    results.set(step.id, sr.answer);
  }
  base.stepResults = stepResults;

  // 3. Check + synthesize (results only, never raw tool output); one optional re-run.
  const ids = plan.steps.map((s) => s.id);
  const synthUser = (note: string) =>
    `TASK:\n${i.prompt}\n\nPLAN:\n${compact(plan.steps.map((s) => ({ id: s.id, instruction: s.instruction, tools: s.tools })))}\n\nSTEP RESULTS:\n${compact(
      stepResults.map((s) => ({ id: s.id, ok: s.answer !== null, result: clip(s.answer), ...(s.error ? { error: s.error.slice(0, 300) } : {}) })),
    )}${note}`;
  const synth = (allowed: string[], note: string) => brainCall(i.brain, i.brainModel, SYNTH_SYSTEM, synthUser(note), "final", wrapperSchema(i.schema, allowed));

  let s1 = await synth(ids, "");
  if (s1.error) return { ...base, error: s1.error };
  let rerun = String(s1.data?.rerun_step_id ?? "none");
  if (rerun !== "none" && ids.includes(rerun)) {
    const idx = plan.steps.findIndex((s) => s.id === rerun);
    const sr = { ...(await runStep(plan.steps[idx]!)), reran: true };
    stepResults[idx] = sr;
    results.set(rerun, sr.answer);
    base.rerunUsed = true;
    base.rerunStepId = rerun;
    s1 = await synth(["none"], `\n\nNOTE: step ${rerun} was re-run once; its result above is the new one. No further re-run is allowed: set rerun_step_id to "none".`);
    if (s1.error) return { ...base, error: s1.error };
  }
  const answer = s1.data?.answer;
  const v = validateAnswer(i.schema, answer);
  return { ...base, answer: v.valid ? answer : (answer ?? null), error: v.valid ? undefined : `final answer failed the schema: ${(v.errors ?? []).join("; ")}` };
}

function clip(v: unknown): unknown {
  const s = compact(v);
  return s.length > MAX_STEP_RESULT_CHARS ? `${s.slice(0, MAX_STEP_RESULT_CHARS)}...[truncated]` : v;
}
