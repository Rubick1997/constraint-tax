import { SYSTEM } from "../tasks/helpers.js";
import type { Arm } from "./arms.js";
import { PLAN_SYSTEM, SYNTH_SYSTEM, toolSpecsText } from "./brain-worker.js";
import { HAIKU, PRICES, SONNET } from "./meter.js";
import { DEMO_TASKS, demoToolDefs, estTokens, makeExecutor, type DemoTask } from "./tasks.js";

export interface Projection {
  claudeCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Upper bound if the brain asks for its one re-run (brain-worker only). */
  maxUsd: number;
}

// Rough assumptions, deliberately on the high side for output (default thinking is on).
const TURN_OUT_TOKENS = 250;
const FINAL_OUT_TOKENS = 300;
const TOOL_CALL_OVERHEAD_TOKENS = 60;
const PLAN_OUT_TOKENS = 600;
const SYNTH_OUT_TOKENS = 250;
const ASSUMED_STEPS = 3;
const STEP_RESULT_TOKENS = 150;

const traceCache = new Map<string, number[]>();
/** Output sizes (tokens) of each tool call of the scripted perfect run. */
function trace(task: DemoTask): number[] {
  let t = traceCache.get(task.id);
  if (!t) {
    const sizes: number[] = [];
    const ex = makeExecutor((_n, _a, out) => sizes.push(estTokens(JSON.stringify(out))));
    task.perfect((n, a) => ex(n, a));
    traceCache.set(task.id, (t = sizes));
  }
  return t;
}

const price = (model: string, i: number, o: number) => (i * PRICES[model]!.input + o * PRICES[model]!.output) / 1e6;

export function projectSession(arm: Arm, task: DemoTask): Projection {
  if (arm.kind === "worker-solo") return { claudeCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0, maxUsd: 0 };
  const tools = demoToolDefs(task);
  if (arm.kind === "brain-worker") {
    const planIn = estTokens(PLAN_SYSTEM + task.prompt + toolSpecsText(tools));
    const synthIn = estTokens(SYNTH_SYSTEM + task.prompt + JSON.stringify(task.schema.schema)) + 120 * ASSUMED_STEPS + STEP_RESULT_TOKENS * ASSUMED_STEPS;
    const usd = price(SONNET, planIn + synthIn, PLAN_OUT_TOKENS + SYNTH_OUT_TOKENS);
    return { claudeCalls: 2, inputTokens: planIn + synthIn, outputTokens: PLAN_OUT_TOKENS + SYNTH_OUT_TOKENS, usd, maxUsd: usd + price(SONNET, synthIn + STEP_RESULT_TOKENS, SYNTH_OUT_TOKENS) };
  }
  const model = arm.kind === "sonnet-solo" ? SONNET : HAIKU;
  const out = trace(task);
  const base = estTokens(SYSTEM + task.prompt + toolSpecsText(tools) + JSON.stringify(task.schema.schema));
  const rounds = Math.max(1, task.depth);
  const perRound = Math.ceil(out.length / rounds);
  let i = 0;
  let o = 0;
  let ctx = base;
  let sent = 0;
  for (let r = 0; r < rounds; r++) {
    i += ctx; // the request that produces this round's tool calls
    o += TURN_OUT_TOKENS;
    const chunk = out.slice(sent, sent + perRound);
    sent += chunk.length;
    ctx += chunk.reduce((s, x) => s + x + TOOL_CALL_OVERHEAD_TOKENS, 0);
  }
  i += ctx; // final request with the schema answer
  o += FINAL_OUT_TOKENS;
  const usd = price(model, i, o);
  return { claudeCalls: rounds + 1, inputTokens: i, outputTokens: o, usd, maxUsd: usd };
}

export function projectAll(arms: Arm[], tasks: DemoTask[] = DEMO_TASKS, reps = 1) {
  const sum: Projection = { claudeCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0, maxUsd: 0 };
  for (const a of arms) for (const t of tasks) {
    const p = projectSession(a, t);
    sum.claudeCalls += p.claudeCalls * reps;
    sum.inputTokens += p.inputTokens * reps;
    sum.outputTokens += p.outputTokens * reps;
    sum.usd += p.usd * reps;
    sum.maxUsd += p.maxUsd * reps;
  }
  return sum;
}
