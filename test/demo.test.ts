import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { Client } from "../src/client.js";
import type { ChatFn } from "../packages/tool-schema-safe/src/index.js";
import { parseArms, meteredChat, usesClaude, type DemoRecord } from "../src/demo/arms.js";
import { normalizeStepSchema, parsePlan, runBrainWorker, substitute } from "../src/demo/brain-worker.js";
import { Meter, costUsd, parseUsage } from "../src/demo/meter.js";
import { projectAll } from "../src/demo/project.js";
import { readDemoRecords, runDemo, type DemoOptions } from "../src/demo/run.js";
import { DEMO_TASKS, checkFields, demoToolDefs, estTokens, makeExecutor } from "../src/demo/tasks.js";
import { DEMO_END, DEMO_START, fillReadme, headlines, renderCsv, renderMarkdown } from "../src/demo/summarize.js";
import { serviceLog } from "../src/demo/data.js";
import { fromAnthropicResponse } from "../src/providers.js";
import type { ChatResult } from "../src/types.js";

const ajv = new Ajv({ strict: false });
const task = (id: string) => DEMO_TASKS.find((t) => t.id === id)!;

describe("demo tasks", () => {
  it("has 6 chain and 4 bulky tasks", () => {
    expect(DEMO_TASKS).toHaveLength(10);
    expect(DEMO_TASKS.filter((t) => t.kind === "chain")).toHaveLength(6);
    expect(DEMO_TASKS.filter((t) => t.kind === "bulky")).toHaveLength(4);
  });
  for (const t of DEMO_TASKS) {
    it(`${t.id}: a scripted perfect agent reproduces the gold answer`, () => {
      let n = 0;
      let biggest = 0;
      const ex = makeExecutor((_n, _a, out) => {
        n++;
        biggest = Math.max(biggest, estTokens(JSON.stringify(out)));
        expect((out as any).error).toBeUndefined();
      });
      const answer = t.perfect((name, args) => ex(name, args));
      expect(answer).toEqual(t.gold);
      expect(ajv.validate(t.schema.schema, t.gold)).toBe(true);
      expect(checkFields(t, t.gold)).toMatchObject({ correct: true, fieldScore: 1 });
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
      if (t.kind === "bulky") expect(biggest).toBeGreaterThan(12000);
      else expect(biggest).toBeLessThan(200);
      // every tool used is offered to the model
      const offered = demoToolDefs(t).map((d) => d.function.name);
      expect(offered.length).toBeGreaterThan(n > 0 ? 2 : 0);
    });
    it(`${t.id}: a wrong field is detected`, () => {
      const wrong: any = { ...t.gold };
      const k = Object.keys(wrong)[0]!;
      wrong[k] = typeof wrong[k] === "number" ? wrong[k] + 1 : typeof wrong[k] === "boolean" ? !wrong[k] : Array.isArray(wrong[k]) ? [] : "zzz";
      const c = checkFields(t, wrong);
      expect(c.correct).toBe(false);
      expect(c.fieldScore).toBeLessThan(1);
      expect(c.fieldScore).toBeGreaterThan(0 - 1e-9);
      expect(checkFields(t, null).fieldScore).toBe(0);
    });
  }
  it("bulky gold answers have no ties on the deciding fields", () => {
    const counts: Record<string, number> = {};
    for (const l of serviceLog("payments-gateway")) {
      const m = /ERROR payments-gateway code=(E-\d+)/.exec(l);
      if (m) counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
    }
    const sorted = Object.values(counts).sort((a, b) => b - a);
    expect(sorted[0]! - sorted[1]!).toBeGreaterThanOrEqual(3);
  });
  it("checkFields: arrays are order-insensitive unless the field is ordered", () => {
    expect(checkFields({ gold: { a: ["x", "y"] } }, { a: ["y", "x"] }).correct).toBe(true);
    expect(checkFields({ gold: { a: ["x", "y"] }, orderedFields: ["a"] }, { a: ["y", "x"] }).correct).toBe(false);
    expect(checkFields({ gold: { n: 1.5 } }, { n: "1.5" }).correct).toBe(false);
  });
});

// ------------------------------------------------------------------ brain-worker orchestration

const resp = (message: any, usage?: any) => ({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage });
const callMsg = (name: string, args: unknown) => resp({ role: "assistant", content: null, tool_calls: [{ id: `c_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

/** Mock worker: first turn calls the step's scripted tool call, second turn submits the scripted answer. */
function mockWorker(script: (instruction: string) => { tool?: [string, unknown]; answer: unknown }, seen: string[] = []): ChatFn {
  return async (body: any) => {
    const msgs = body.messages as any[];
    const instruction = msgs.find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("Please finish"))!.content as string;
    const hasToolResult = msgs.some((m) => m.role === "tool");
    const s = script(instruction);
    if (!hasToolResult && s.tool) {
      seen.push(instruction);
      return callMsg(s.tool[0], s.tool[1]);
    }
    if (!hasToolResult) seen.push(instruction);
    return callMsg("submit_answer", s.answer);
  };
}

const PLAN = {
  steps: [
    { id: "s1", instruction: "Get the weather for Quillfen Bay and convert it to Celsius.", tools: ["get_weather_f", "convert_temperature"], output_schema_json: JSON.stringify({ type: "object", properties: { c: { type: "number" } } }) },
    { id: "s2", instruction: "Given the earlier result {{s1}}, get Dorrowmere weather in Celsius.", tools: ["get_weather_f", "convert_temperature"], output_schema_json: JSON.stringify({ type: "object", properties: { c: { type: "number" } } }) },
  ],
};

function mockBrain(opts: { rerunFirst?: string; alwaysRerun?: string } = {}) {
  const bodies: any[] = [];
  const names: string[] = [];
  const chat: ChatFn = async (body: any) => {
    bodies.push(body);
    const name = body.response_format.json_schema.name;
    names.push(name);
    if (name === "plan") return resp({ role: "assistant", content: JSON.stringify(PLAN) }, { prompt_tokens: 100, completion_tokens: 50 });
    const enumVals: string[] = body.response_format.json_schema.schema.properties.rerun_step_id.enum;
    const synthCalls = names.filter((n) => n === "final").length;
    const rerun = opts.alwaysRerun ?? (synthCalls === 1 ? opts.rerunFirst : undefined);
    return resp({ role: "assistant", content: JSON.stringify({ rerun_step_id: rerun ?? "none", answer: { ...task("c02").gold, _enum: undefined } }) }, { prompt_tokens: 200, completion_tokens: 40, _enum: enumVals });
  };
  return { chat, bodies, names };
}

const runBW = (brain: ChatFn, worker: ChatFn) => {
  const t = task("c02");
  return runBrainWorker({ prompt: t.prompt, tools: demoToolDefs(t), schema: t.schema.schema, brain, brainModel: "claude-sonnet-5-5", worker, workerModel: "mock:1b", executeTool: makeExecutor() });
};
const workerScript = (instruction: string) =>
  instruction.startsWith("Get the weather") ? { tool: ["convert_temperature", { value: 74.3, to_scale: "C" }] as [string, unknown], answer: { c: 23.5 } } : { tool: ["convert_temperature", { value: 68.9, to_scale: "C" }] as [string, unknown], answer: { c: 20.5 } };

describe("brain-worker orchestration", () => {
  it("plans, executes steps with substituted results, then synthesizes (no re-run)", async () => {
    const brain = mockBrain();
    const seen: string[] = [];
    const out = await runBW(brain.chat, mockWorker(workerScript, seen));
    expect(brain.names).toEqual(["plan", "final"]);
    expect(out.error).toBeUndefined();
    expect(out.rerunUsed).toBe(false);
    expect(out.plan?.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(out.stepResults.map((r) => r.answer)).toEqual([{ c: 23.5 }, { c: 20.5 }]);
    // the harness substituted s1's result as compact JSON into s2's instruction
    expect(seen[1]).toBe('Given the earlier result {"c":23.5}, get Dorrowmere weather in Celsius.');
    expect(out.stepResults[1]!.instruction).toContain('{"c":23.5}');
    expect(out.answer).toMatchObject(task("c02").gold);
  });

  it("the brain never sees raw tool output or tool calls", async () => {
    const brain = mockBrain();
    await runBW(brain.chat, mockWorker(workerScript));
    for (const b of brain.bodies) {
      expect(b.tools).toBeUndefined();
      expect(b.tool_choice).toBeUndefined();
      const text = JSON.stringify(b.messages);
      expect(text).not.toContain("74.3");
      expect(text).not.toContain("tool_calls");
    }
    // tool names and parameter schemas are given to the planner
    expect(JSON.stringify(brain.bodies[0].messages)).toContain("get_weather_f");
    // the synthesis call sees step results, not raw tool output
    expect(brain.bodies[1].messages[1].content).toContain('"result":{"c":23.5}');
  });

  it("allows exactly one re-run: one extra worker step and one extra brain call", async () => {
    const brain = mockBrain({ rerunFirst: "s1" });
    const seen: string[] = [];
    const out = await runBW(brain.chat, mockWorker(workerScript, seen));
    expect(out.rerunUsed).toBe(true);
    expect(out.rerunStepId).toBe("s1");
    expect(brain.names).toEqual(["plan", "final", "final"]);
    expect(seen).toHaveLength(3); // s1, s2, s1 again
    expect(out.stepResults[0]!.reran).toBe(true);
    // the second synthesis can only answer "none"
    expect(brain.bodies[2].response_format.json_schema.schema.properties.rerun_step_id.enum).toEqual(["none"]);
    expect(brain.bodies[1].response_format.json_schema.schema.properties.rerun_step_id.enum).toEqual(["s1", "s2", "none"]);
  });

  it("caps re-runs even if the brain asks again", async () => {
    const brain = mockBrain({ alwaysRerun: "s2" });
    const seen: string[] = [];
    const out = await runBW(brain.chat, mockWorker(workerScript, seen));
    expect(brain.names).toEqual(["plan", "final", "final"]); // never a fourth call
    expect(seen).toHaveLength(3);
    expect(out.rerunUsed).toBe(true);
    expect(out.answer).toMatchObject(task("c02").gold);
  });

  it("records a failed worker step and still synthesizes", async () => {
    const brain = mockBrain();
    const worker: ChatFn = async () => resp({ role: "assistant", content: "I do not know" });
    const out = await runBW(brain.chat, worker);
    expect(out.stepResults.every((r) => r.answer === null && r.error)).toBe(true);
    expect(brain.names).toEqual(["plan", "final"]);
  });

  it("rejects bad plans and normalises step schemas", () => {
    expect(parsePlan({ steps: [] }, []).error).toMatch(/no steps/);
    expect(parsePlan({ steps: [{ id: "a", instruction: "x", tools: [], output_schema_json: "{}" }, { id: "a", instruction: "y", tools: [], output_schema_json: "{}" }] }, []).error).toMatch(/duplicated/);
    const p = parsePlan({ steps: [{ id: "s1", instruction: "x", tools: ["nope", "get_weather_f"], output_schema_json: '{"type":"object","properties":{"a":{"type":"number"}}}' }] }, ["get_weather_f"]);
    expect(p.plan!.steps[0]!.tools).toEqual(["get_weather_f"]);
    expect(p.plan!.steps[0]!.output_schema).toMatchObject({ required: ["a"], additionalProperties: false });
    expect(normalizeStepSchema("not json")).toMatchObject({ required: ["result"] });
    expect(substitute("a {{s1}} b {{zz}}", new Map([["s1", { x: [1, 2] }]]))).toBe('a {"x":[1,2]} b {{zz}}');
  });
});

// ------------------------------------------------------------------ cost math

describe("cost math", () => {
  it("prices Sonnet 5.5 and Haiku 5.5 per million tokens", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costUsd("claude-sonnet-5-5", u)).toBeCloseTo(12, 9);
    expect(costUsd("claude-haiku-5-5", u)).toBeCloseTo(0.6, 9);
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.003, 9);
  });
  it("prices cache reads and writes separately", () => {
    // 1000 input total: 400 plain, 300 cache write (1.25x), 300 cache read (0.1x); 0 output
    const c = costUsd("claude-sonnet-5-5", { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 300 });
    expect(c).toBeCloseTo((400 * 2 + 300 * 2 * 1.25 + 300 * 2 * 0.1) / 1e6, 12);
  });
  it("reads usage from the Anthropic adapter's response shape", () => {
    const json = fromAnthropicResponse({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } });
    expect(parseUsage(json.usage)).toEqual({ inputTokens: 650, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 50 });
    expect(parseUsage({ prompt_tokens: 7, completion_tokens: 3 })).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });
  it("meteredChat prices Claude calls and leaves local calls free", async () => {
    const client: Client = { chat: async () => ({ ok: true, status: 200, rawText: "", latencyMs: 5, json: resp({ role: "assistant", content: "{}" }, { prompt_tokens: 1000, completion_tokens: 100 }) }), getKeyInfo: async () => ({}) };
    const m = new Meter();
    const seen: number[] = [];
    await meteredChat(client, m, { onCost: (c) => seen.push(c) })({ model: "claude-sonnet-5-5", messages: [] });
    await meteredChat(client, m)({ model: "lfm3:1.7b", messages: [] });
    expect(m.calls).toBe(2);
    expect(m.inputTokens).toBe(2000);
    expect(m.costUsd).toBeCloseTo(0.003, 9);
    expect(seen).toHaveLength(1);
  });
  it("projects Claude calls and dollars for the full design", () => {
    const p = projectAll(parseArms("all"), DEMO_TASKS, 2);
    expect(p.claudeCalls).toBeGreaterThan(100);
    expect(p.usd).toBeGreaterThan(0.5);
    expect(p.usd).toBeLessThan(5);
  });
});

// ------------------------------------------------------------------ runner: gate, resume, cap

const ok = (json: any, latencyMs = 3): ChatResult => ({ ok: true, status: 200, rawText: "", latencyMs, json });
function setup(over: Partial<DemoOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demo-"));
  const opts: DemoOptions = { arms: "worker-solo:mock:1b", tasks: ["c01", "c02"], reps: 1, out: join(dir, "runs", "demo.jsonl"), yes: false, dryRun: false, ...over };
  const calls = { claude: [] as any[], ollama: [] as any[] };
  const goldFor = (body: any) => {
    const name = body.tools?.find((t: any) => t.function.name === "submit_answer") ? "submit" : "native";
    const text = JSON.stringify(body.messages);
    const t = DEMO_TASKS.find((x) => text.includes(x.prompt.slice(0, 60)))!;
    return { name, gold: t.gold };
  };
  const claude: Client = {
    chat: async (body) => {
      calls.claude.push(body);
      return ok(resp({ role: "assistant", content: JSON.stringify(goldFor(body).gold) }, { prompt_tokens: 1000, completion_tokens: 100 }));
    },
    getKeyInfo: async () => ({}),
  };
  const ollama: Client = {
    chat: async (body) => {
      calls.ollama.push(body);
      return ok(callMsg("submit_answer", goldFor(body).gold));
    },
    getKeyInfo: async () => ({}),
  };
  const logs: string[] = [];
  const deps = { claude, ollama, now: () => 1_000, log: (s: string) => logs.push(s) };
  return { opts, deps, calls, logs, dir };
}

describe("demo runner", () => {
  it("refuses Claude arms without BOTH --max-usd and --yes (exit 2, nothing sent)", async () => {
    for (const over of [{}, { yes: true }, { maxUsd: 1 }]) {
      const s = setup({ arms: "sonnet-solo", ...over });
      const r = await runDemo(s.opts, s.deps);
      expect(r.exitCode).toBe(2);
      expect(s.calls.claude).toHaveLength(0);
      expect(s.logs.join("\n")).toMatch(/--max-usd/);
      expect(s.logs.join("\n")).toMatch(/Projected Claude calls/);
    }
    const bw = setup({ arms: "brain-worker:mock:1b" });
    expect((await runDemo(bw.opts, bw.deps)).exitCode).toBe(2);
  });

  it("dry run prints the projection and sends nothing, even for Claude arms", async () => {
    const s = setup({ arms: "all", dryRun: true, reps: 2, tasks: ["all"] });
    const r = await runDemo(s.opts, s.deps);
    expect(r.exitCode).toBe(0);
    expect(s.calls.claude.length + s.calls.ollama.length).toBe(0);
    expect(s.logs.join("\n")).toMatch(/Projected Claude calls \(pending\): \d+; projected Claude spend: \$\d/);
  });

  it("runs local-only arms without the paid gate, and records metrics", async () => {
    const s = setup();
    const r = await runDemo(s.opts, s.deps);
    expect(r.exitCode).toBe(0);
    expect(r.written).toBe(2);
    expect(s.calls.claude).toHaveLength(0);
    const recs = [...(await readDemoRecords(s.opts.out)).values()];
    expect(recs.map((x) => x.key).sort()).toEqual(["worker-solo:mock:1b|c01|1", "worker-solo:mock:1b|c02|1"]);
    expect(recs[0]).toMatchObject({ correct: true, fieldScore: 1, claudeCalls: 0, claudeCostUsd: 0, workerCalls: 1, workerTemperature: 0, rerunUsed: false, error: null });
    expect(s.calls.ollama[0].temperature).toBe(0);
  });

  it("resume skips finished keys and retries transient ones", async () => {
    const s = setup();
    await runDemo(s.opts, s.deps);
    const n = s.calls.ollama.length;
    const again = await runDemo(s.opts, s.deps);
    expect(again.written).toBe(0);
    expect(s.calls.ollama.length).toBe(n);
    // mark one record transient: only that one is redone
    const lines = readFileSync(s.opts.out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as DemoRecord);
    lines[0] = { ...lines[0]!, transient: true, error: "HTTP 503: boom", correct: false };
    writeFileSync(s.opts.out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const third = await runDemo(s.opts, s.deps);
    expect(third.written).toBe(1);
    expect(s.calls.ollama.length).toBe(n + 1);
    expect([...(await readDemoRecords(s.opts.out)).values()].every((r) => r.correct)).toBe(true);
  });

  it("runs Claude solo with native structured output and no forced tool_choice, and tracks spend", async () => {
    const s = setup({ arms: "sonnet-solo,haiku-solo", maxUsd: 1, yes: true });
    const r = await runDemo(s.opts, s.deps);
    expect(r.exitCode).toBe(0);
    for (const b of s.calls.claude) {
      expect(b.tool_choice).toBeUndefined();
      expect(b.response_format.type).toBe("json_schema");
      expect(b.tools.some((t: any) => t.function.name === "submit_answer")).toBe(false);
    }
    const recs = [...(await readDemoRecords(s.opts.out)).values()];
    const sonnet = recs.find((x) => x.arm === "sonnet-solo")!;
    const haiku = recs.find((x) => x.arm === "haiku-solo")!;
    expect(sonnet.claudeCostUsd).toBeCloseTo(0.003, 9);
    expect(haiku.claudeCostUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 12);
    expect(r.spentUsd).toBeCloseTo(2 * 0.003 + 2 * ((1000 * 0.1 + 100 * 0.5) / 1e6), 9);
  });

  it("stops when actual spend reaches --max-usd", async () => {
    const s = setup({ arms: "sonnet-solo", tasks: ["c01", "c02", "c03", "c04"], maxUsd: 0.004, yes: true });
    const r = await runDemo(s.opts, s.deps);
    expect(r.written).toBe(2); // 0.003 < 0.004, then 0.006 >= 0.004
    expect(r.stopReason).toMatch(/max-usd/);
    expect(r.spentUsd).toBeCloseTo(0.006, 9);
  });
});

describe("arms and summary", () => {
  it("parses arm specs", () => {
    expect(parseArms("all").map((a) => a.name)).toEqual(["sonnet-solo", "haiku-solo", "worker-solo:lfm3:1.7b", "worker-solo:gemma4:26b-a4b", "brain-worker:lfm3:1.7b", "brain-worker:gemma4:26b-a4b"]);
    expect(parseArms("brain-worker:qwen3.6:35b-a3b")[0]).toMatchObject({ kind: "brain-worker", workerModel: "qwen3.6:35b-a3b" });
    expect(usesClaude(parseArms("worker-solo")[0]!)).toBe(false);
    expect(() => parseArms("nope")).toThrow();
  });

  const rec = (arm: string, task: string, kind: "chain" | "bulky", correct: boolean, cost: number): DemoRecord => ({
    key: `${arm}|${task}|1`, arm, task, kind, rep: 1, startedAt: "", correct, fieldScore: correct ? 1 : 0.5, claudeCalls: 2, claudeInputTokens: 1000, claudeOutputTokens: 100,
    claudeCacheReadTokens: 0, claudeCacheWriteTokens: 0, claudeCostUsd: cost, claudeLatencyMs: 1, workerCalls: 3, workerLatencyMs: 1, toolCalls: 3, totalLatencyMs: 2000, workerModel: null,
    workerTemperature: null, plan: null, stepResults: null, rerunUsed: false, error: null, transient: false, finalAnswer: null,
  });
  const rows = [rec("sonnet-solo", "c01", "chain", true, 0.1), rec("sonnet-solo", "b01", "bulky", true, 0.3), rec("brain-worker:x", "c01", "chain", true, 0.02), rec("brain-worker:x", "b01", "bulky", false, 0.02)];

  it("writes the headline, tables and csv", () => {
    expect(headlines(rows)).toEqual(["brain-worker:x vs sonnet-solo: 10% of the Claude cost at 50% vs 100% accuracy."]);
    const md = renderMarkdown(rows);
    expect(md).toContain("Chain tasks");
    expect(md).toContain("Bulky tasks");
    expect(md).toContain("brain-worker:x");
    const csv = renderCsv(rows).trim().split("\n");
    expect(csv[0]).toMatch(/^arm,split,n,correct,accuracy/);
    expect(csv).toHaveLength(1 + 2 * 3);
  });

  it("fills the README placeholder block", () => {
    const text = `a\n${DEMO_START}${DEMO_END}\nb`;
    expect(fillReadme(text, "X")).toBe(`a\n${DEMO_START}\nX\n${DEMO_END}\nb`);
    expect(fillReadme("no markers", "X")).toBeNull();
  });
});
