import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBench, type RunOptions } from "../src/run.js";
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
    const s = setup([{ id: "p/m", role: "closed-control", pricing: { prompt: "0.000001", completion: "0.000004" } }], { models: "controls" });
    const deps = s.mk(() => answerRes());
    expect((await runBench(s.opts, deps)).exitCode).toBe(2);
    expect((await runBench({ ...s.opts, maxUsd: 1 }, deps)).exitCode).toBe(2);
    expect((await runBench({ ...s.opts, dryRun: true }, deps)).exitCode).toBe(0);
    expect(s.calls).toHaveLength(0);
  });

  it("stops before exceeding --max-usd", async () => {
    const s = setup([{ id: "p/m", role: "closed-control", pricing: { prompt: "0.000001", completion: "0.000004" } }], { models: "controls", maxUsd: 0.0001, yes: true });
    const r = await runBench(s.opts, s.mk(() => answerRes()));
    expect(r.stopReason).toMatch(/max-usd/);
    expect(s.calls).toHaveLength(0);
  });
});
