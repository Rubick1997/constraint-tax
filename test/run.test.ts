import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConditions, runBench, type RunOptions } from "../src/run.js";
import { summarizeWorkarounds } from "../src/summarize.js";
import { TASKS } from "../src/tasks/index.js";
import type { ChatResult, SessionRecord } from "../src/types.js";
import type { Client } from "../src/client.js";

const toolCallRes = (): ChatResult => ({ ok: true, status: 200, latencyMs: 1, rawText: "", json: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "get_order_status", arguments: '{"order_id":"QX-48213"}' } }] } }] } });
const answerRes = (): ChatResult => ({ ok: true, status: 200, latencyMs: 1, rawText: "", json: { choices: [{ finish_reason: "stop", message: { content: '{"status":"held_at_customs","tracking_number":"ZK8-55107-T","eta_days":6}' } }] } });
const status = (s: number): ChatResult => ({ ok: false, status: s, latencyMs: 1, rawText: "", json: { error: { message: "boom" } } });

function setup(models: { id: string; role: string; pricing?: any }[], over: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ models }));
  const opts: RunOptions = {
    models: "all-free", conditions: ["tools-only"], tasks: ["t01", "t02", "t03", "t04", "t05"], reps: 1,
    out: join(dir, "runs.jsonl"), freeLimit: 900, yes: false, dryRun: false,
    modelsFile: join(dir, "models.json"), quotaFile: join(dir, "quota.json"), intervalMs: 3100, ...over,
  };
  let clock = Date.parse("2026-11-24T10:00:00Z");
  const sleeps: number[] = [];
  const calls: any[] = [];
  const mk = (handler: (body: any, n: number) => ChatResult) => {
    const client: Client = { chat: async (b) => handler((calls.push(b), b), calls.length), getKeyInfo: async () => ({ usage: 1, limit: 10 }) };
    return { client, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; }, now: () => clock, log: () => {}, tasks: TASKS };
  };
  const lines = () => readFileSync(opts.out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionRecord);
  return { opts, mk, calls, sleeps, lines, dir };
}

describe("runner", () => {
  it("resume skips completed keys and retries transient ones", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { tasks: ["t01", "t02"] });
    let n = 0;
    const deps1 = s.mk((b) => { n++; return b.messages.length === 2 ? (n === 3 ? status(503) : toolCallRes()) : answerRes(); });
    await runBench(s.opts, deps1);
    // t01: 2 requests ok; t02 first request 503 (transient)
    expect(s.lines()).toHaveLength(2);
    s.calls.length = 0;
    const deps2 = s.mk((b) => (b.messages.length === 2 ? toolCallRes() : answerRes()));
    await runBench(s.opts, deps2);
    const t02Calls = s.calls.filter((b) => b.messages[1].content.includes("zorbits"));
    expect(t02Calls.length).toBeGreaterThan(0);
    expect(s.calls.filter((b) => b.messages[1].content.includes("QX-48213"))).toHaveLength(0);
    const last = new Map(s.lines().map((r) => [r.key, r]));
    expect(last.size).toBe(2);
    expect(s.lines()).toHaveLength(3);
    // third run: nothing pending
    s.calls.length = 0;
    await runBench(s.opts, s.mk(() => answerRes()));
    expect(s.calls).toHaveLength(0);
  });

  it("circuit breaker opens after 3 consecutive failures", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }, { id: "b/y:free", role: "free" }]);
    const deps = s.mk((b) => (b.model === "a/x:free" ? status(500) : b.messages.length === 2 ? toolCallRes() : answerRes()));
    const r = await runBench(s.opts, deps);
    expect(Object.keys(r.stopped)).toEqual(["a/x:free"]);
    expect(s.lines().filter((l) => l.model === "a/x:free")).toHaveLength(3);
    expect(s.lines().filter((l) => l.model === "b/y:free")).toHaveLength(5);
  });

  it("skips an unsupported cell after 2 unsupported, without requests", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }]);
    const uns: ChatResult = { ok: false, status: 404, latencyMs: 1, rawText: "", json: { error: { message: "No endpoints found that can handle the requested parameters" } } };
    await runBench(s.opts, s.mk(() => uns));
    const ls = s.lines();
    expect(ls.map((l) => l.firstOutcome)).toEqual(["unsupported", "unsupported", "skipped", "skipped", "skipped"]);
    expect(ls[2]!.skipped).toBe("unsupported-cell");
    expect(s.calls).toHaveLength(2);
  });

  it("rate-limits spacing and stops at free quota, counting attempts", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { freeLimit: 3, tasks: ["t01", "t02"] });
    const r = await runBench(s.opts, s.mk((b) => (b.messages.length === 2 ? toolCallRes() : answerRes())));
    expect(r.stopReason).toMatch(/quota/);
    expect(s.calls).toHaveLength(3);
    expect(JSON.parse(readFileSync(s.opts.quotaFile, "utf8"))["2026-11-24"]).toBe(3);
    expect(s.sleeps.every((x) => x >= 3100 - 1)).toBe(true);
  });

  it("paid models need --max-usd and --yes; dry-run sends nothing", async () => {
    const s = setup([{ id: "p/m", role: "closed-control", pricing: { prompt: "0.000001", completion: "0.000004" } }], { models: "p/m" });
    const deps = s.mk(() => answerRes());
    expect((await runBench(s.opts, deps)).exitCode).toBe(2);
    expect((await runBench({ ...s.opts, maxUsd: 1 }, deps)).exitCode).toBe(2);
    expect((await runBench({ ...s.opts, dryRun: true }, deps)).exitCode).toBe(0);
    expect(s.calls).toHaveLength(0);
  });

  it("stops before exceeding --max-usd", async () => {
    const s = setup([{ id: "p/m", role: "closed-control", pricing: { prompt: "0.000001", completion: "0.000004" } }], { models: "p/m", maxUsd: 0.0001, yes: true });
    const r = await runBench(s.opts, s.mk(() => answerRes()));
    expect(r.stopReason).toMatch(/max-usd/);
    expect(s.calls).toHaveLength(0);
  });

  it("retried 429s count toward quota, sleep 20s, and a recovered session resets the breaker", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { tasks: ["t01", "t02"] });
    const r429: ChatResult = { ok: false, status: 429, latencyMs: 1, rawText: "", json: { error: { message: "rate-limited" } } };
    let first = true;
    const r = await runBench(s.opts, s.mk((b) => {
      if (first) { first = false; return r429; }
      return b.messages.length === 2 ? toolCallRes() : answerRes();
    }));
    expect(s.calls).toHaveLength(5); // 1x429 + 2 for t01, 2 for t02
    expect(JSON.parse(readFileSync(s.opts.quotaFile, "utf8"))["2026-11-24"]).toBe(5);
    expect(s.sleeps).toContain(20000);
    expect(r.stopped).toEqual({});
    const [a, b] = s.lines();
    expect(a!.rateLimitedAttempts).toBe(1);
    expect(a!.firstOutcome).toBe("tool_called");
    expect(b!.rateLimitedAttempts).toBe(0);
  });

  it("quota stop applies before each retry attempt", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { freeLimit: 2, tasks: ["t01"] });
    const r429: ChatResult = { ok: false, status: 429, latencyMs: 1, rawText: "", json: { error: { message: "rate-limited" } } };
    const r = await runBench(s.opts, s.mk(() => r429));
    expect(s.calls).toHaveLength(2);
    expect(r.stopReason).toMatch(/quota/);
  });

  it("breaker opens after 3 sessions that stay 429 after all retries", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }]);
    const r429: ChatResult = { ok: false, status: 429, latencyMs: 1, rawText: "", json: { error: { message: "rate-limited" } } };
    const r = await runBench(s.opts, s.mk(() => r429));
    expect(Object.keys(r.stopped)).toEqual(["a/x:free"]);
    expect(s.lines()).toHaveLength(3);
    expect(s.calls).toHaveLength(12);
  });

  const okFor = (b: any) => (b.messages.length === 2 ? toolCallRes() : answerRes());
  const r429: ChatResult = { ok: false, status: 429, latencyMs: 1, rawText: "", json: { error: { message: "rate-limited" } } };
  const sessionModels = (lines: SessionRecord[]) => lines.map((l) => l.model);

  it("orders sessions round-robin across models", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }, { id: "b/y:free", role: "free" }, { id: "c/z:free", role: "free" }], { tasks: ["t01", "t02"] });
    await runBench(s.opts, s.mk(okFor));
    expect(sessionModels(s.lines())).toEqual(["a/x:free", "b/y:free", "c/z:free", "a/x:free", "b/y:free", "c/z:free"]);
  });

  it("skips a model whose breaker opened and keeps rotating the rest", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }, { id: "b/y:free", role: "free" }, { id: "c/z:free", role: "free" }]);
    const r = await runBench(s.opts, s.mk((b) => (b.model === "b/y:free" ? status(500) : okFor(b))));
    expect(Object.keys(r.stopped)).toEqual(["b/y:free"]);
    const order = sessionModels(s.lines());
    expect(order.slice(0, 9)).toEqual(["a/x:free", "b/y:free", "c/z:free", "a/x:free", "b/y:free", "c/z:free", "a/x:free", "b/y:free", "c/z:free"]);
    expect(order.slice(9)).toEqual(["a/x:free", "c/z:free", "a/x:free", "c/z:free"]);
    expect(order.filter((m) => m === "b/y:free")).toHaveLength(3);
  });

  it("cools a 429'd model down for 60s while other models proceed", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }, { id: "b/y:free", role: "free" }], { tasks: ["t01", "t02"], intervalMs: 0 });
    let aFirst = true;
    const starts: Record<string, number[]> = { "a/x:free": [], "b/y:free": [] };
    const deps = s.mk((b) => {
      if (b.model === "a/x:free" && aFirst) { aFirst = false; return r429; }
      return okFor(b);
    });
    await runBench(s.opts, deps);
    for (const l of s.lines()) starts[l.model]!.push(Date.parse(l.startedAt));
    expect(sessionModels(s.lines())).toEqual(["a/x:free", "b/y:free", "b/y:free", "a/x:free"]);
    const a1End = starts["b/y:free"]![0]!; // b's first session starts right after a's first ended
    expect(starts["a/x:free"]![1]! - a1End).toBeGreaterThanOrEqual(60_000 - 100);
    expect(s.sleeps.some((x) => x >= 50_000)).toBe(true);
  });

  it("sleeps until the earliest cooldown when every model is cooling down", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { tasks: ["t01", "t02"], intervalMs: 0 });
    let first = true;
    await runBench(s.opts, s.mk((b) => (first ? ((first = false), r429) : okFor(b))));
    expect(s.sleeps.some((x) => x >= 60_000 - 100)).toBe(true);
  });

  it("quota is read-modify-write per request (external change is honoured)", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { tasks: ["t01"] });
    writeFileSync(s.opts.quotaFile, JSON.stringify({ "2026-11-24": 2 }));
    const deps = s.mk((b) => {
      if (s.calls.length === 1) writeFileSync(s.opts.quotaFile, JSON.stringify({ "2026-11-24": 40, "2026-11-23": 7 }));
      return okFor(b);
    });
    await runBench(s.opts, deps);
    expect(s.calls).toHaveLength(2);
    const q = JSON.parse(readFileSync(s.opts.quotaFile, "utf8"));
    expect(q["2026-11-24"]).toBe(41); // 40 set mid-run, +1
    expect(q["2026-11-23"]).toBe(7);
  });
});

describe("workaround conditions", () => {
  const submit = (): ChatResult => ({ ok: true, status: 200, latencyMs: 1, rawText: "", json: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "s", type: "function", function: { name: "submit_answer", arguments: '{"status":"held_at_customs","tracking_number":"ZK8-55107-T","eta_days":6}' } }] } }] } });

  it("parseConditions: all excludes workarounds; workarounds alias; unknown throws", () => {
    expect(parseConditions("all")).toEqual(["tools-only", "schema-only", "tools+schema", "tools+schema+required"]);
    expect(parseConditions("workarounds")).toEqual(["wa-two-phase", "wa-answer-as-tool"]);
    expect(parseConditions("wa-two-phase,tools-only")).toEqual(["wa-two-phase", "tools-only"]);
    expect(() => parseConditions("nope")).toThrow();
  });

  it("dry-run projects 3 requests for wa-two-phase and 2 for wa-answer-as-tool", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { conditions: ["wa-two-phase", "wa-answer-as-tool"], tasks: ["t01"], dryRun: true });
    const logs: string[] = [];
    const deps = { ...s.mk(() => answerRes()), log: (l: string) => logs.push(l) };
    await runBench(s.opts, deps);
    expect(logs.join("\n")).toMatch(/free 5/);
    expect(s.calls).toHaveLength(0);
  });

  it("runs both workarounds end to end, counting every request in quota", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { conditions: ["wa-two-phase", "wa-answer-as-tool"], tasks: ["t01"] });
    const deps = s.mk((b) => {
      const names = (b.tools ?? []).map((t: any) => t.function.name);
      if (names.includes("submit_answer")) return b.messages.some((m: any) => m.role === "tool") ? submit() : toolCallRes();
      if (b.response_format) return answerRes();
      return b.messages.some((m: any) => m.role === "tool") ? { ...answerRes(), json: { choices: [{ finish_reason: "stop", message: { content: "done" } }] } } : toolCallRes();
    });
    await runBench(s.opts, deps);
    const recs = new Map(s.lines().map((r) => [r.condition, r]));
    const tp = recs.get("wa-two-phase")!;
    const aat = recs.get("wa-answer-as-tool")!;
    for (const r of [tp, aat]) {
      expect(r).toMatchObject({ toolCalled: true, toolCorrect: true, schemaValid: true, answerCorrect: true, e2eSuccess: true, firstOutcome: "tool_called" });
      expect(r.key).toMatch(/\|wa-/);
    }
    expect(tp.requests).toHaveLength(3);
    expect(aat.requests).toHaveLength(2);
    expect(JSON.parse(readFileSync(s.opts.quotaFile, "utf8"))["2026-11-24"]).toBe(5);
    // resume: nothing pending
    s.calls.length = 0;
    await runBench(s.opts, s.mk(() => answerRes()));
    expect(s.calls).toHaveLength(0);
  });

  it("summarizeWorkarounds reports mean calls and median latency", async () => {
    const s = setup([{ id: "a/x:free", role: "free" }], { conditions: ["wa-two-phase"], tasks: ["t01"] });
    await runBench(s.opts, s.mk((b) => (b.response_format ? answerRes() : b.messages.some((m: any) => m.role === "tool") ? { ...answerRes(), json: { choices: [{ finish_reason: "stop", message: { content: "x" } }] } } : toolCallRes())));
    const t = summarizeWorkarounds(s.lines());
    expect(t).toMatch(/wa-two-phase \| 1 \| 1\/1 \(100%\) \| 3\.00 \| 3/);
  });
});
