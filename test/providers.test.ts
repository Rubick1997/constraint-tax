import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/conditions.js";
import { createClient, type Client } from "../src/client.js";
import { classifyFirst } from "../src/classify.js";
import { createAnthropicClient, createOllamaClient, toAnthropicRequest } from "../src/providers.js";
import { runBench, type RunOptions } from "../src/run.js";
import { runSession } from "../src/session.js";
import { TASKS } from "../src/tasks/index.js";
import type { ChatResult, SessionRecord } from "../src/types.js";

const task = TASKS[0]!;
const thinking = { type: "thinking", thinking: "hmm", signature: "sig123" };
const toolUseMsg = (extra: any[] = []) => ({
  id: "m1", model: "claude-haiku-5-5", stop_reason: "tool_use",
  content: [thinking, { type: "text", text: "checking" }, { type: "tool_use", id: "tu1", name: "get_order_status", input: { order_id: "QX-48213" } }, ...extra],
  usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 20 },
});
const answerMsg = {
  id: "m2", model: "claude-haiku-5-5", stop_reason: "end_turn",
  content: [{ type: "text", text: '{"status":"held_at_customs",' }, { type: "text", text: '"tracking_number":"ZK8-55107-T","eta_days":6}' }],
  usage: { input_tokens: 200, output_tokens: 30 },
};
const mockSdk = (replies: any[]) => {
  const params: any[] = [];
  return { params, sdk: { messages: { create: async (p: any) => { params.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } } };
};
const body = (condition: any, turn = 1, messages: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }]) =>
  buildRequest("claude-haiku-5-5", task, condition, messages, turn, { provider: "anthropic" });

describe("anthropic request translation", () => {
  it("tools-only: system hoisted, tools mapped, no output_config/tool_choice/temperature", () => {
    const p = toAnthropicRequest(body("tools-only"));
    expect(p.system).toBe("SYS");
    expect(p.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(p.tools[0]).toEqual({ name: task.tools[0]!.function.name, description: task.tools[0]!.function.description, input_schema: task.tools[0]!.function.parameters });
    expect(p.output_config).toBeUndefined();
    expect(p.tool_choice).toBeUndefined();
    expect("temperature" in p).toBe(false);
    expect("thinking" in p).toBe(false);
    expect(p.max_tokens).toBe(4096);
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.provider).toBeUndefined();
    expect(p.usage).toBeUndefined();
  });
  it("schema-only: output_config.format json_schema, no tools", () => {
    const p = toAnthropicRequest(body("schema-only"));
    expect(p.output_config).toEqual({ format: { type: "json_schema", schema: task.schema.schema } });
    expect(p.tools).toBeUndefined();
  });
  it("tools+schema: both, no tool_choice", () => {
    const p = toAnthropicRequest(body("tools+schema"));
    expect(p.tools).toHaveLength(task.tools.length);
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.tool_choice).toBeUndefined();
  });
  it("required: tool_choice any on turn 1 only", () => {
    expect(toAnthropicRequest(body("tools+schema+required", 1)).tool_choice).toEqual({ type: "any" });
    expect(toAnthropicRequest(body("tools+schema+required", 2)).tool_choice).toBeUndefined();
  });
  it("assistant tool_calls -> tool_use; all tool results of a turn in ONE user message", () => {
    const calls = [
      { id: "a", type: "function", function: { name: "x", arguments: '{"k":1}' } },
      { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
    ];
    const p = toAnthropicRequest(body("tools+schema", 2, [
      { role: "system", content: "SYS" }, { role: "user", content: "hi" },
      { role: "assistant", content: "t", tool_calls: calls },
      { role: "tool", tool_call_id: "a", content: "1" }, { role: "tool", tool_call_id: "b", content: "2" },
    ]));
    expect(p.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "t" }, { type: "tool_use", id: "a", name: "x", input: { k: 1 } }, { type: "tool_use", id: "b", name: "y", input: {} }] });
    expect(p.messages).toHaveLength(3);
    expect(p.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "1" }, { type: "tool_result", tool_use_id: "b", content: "2" }] });
  });
  it("replays raw content incl. thinking blocks unchanged on the next request", async () => {
    const { sdk, params } = mockSdk([toolUseMsg(), answerMsg]);
    const rec = await runSession({ chat: createAnthropicClient({ sdk }).chat, pricing: { prompt: 1e-7, completion: 5e-7 } }, { model: "claude-haiku-5-5", provider: "anthropic", condition: "tools+schema+required", task, rep: 1 });
    expect(params).toHaveLength(2);
    expect(params[0].tool_choice).toEqual({ type: "any" });
    expect(params[1].tool_choice).toBeUndefined();
    expect(params[1].messages[1]).toEqual({ role: "assistant", content: toolUseMsg().content });
    expect(params[1].messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    expect(rec).toMatchObject({ provider: "anthropic", requireParameters: false, e2eSuccess: true, firstOutcome: "tool_called" });
    expect(rec.requests.map((q) => [q.providerName, q.rawStopReason, q.finishReason])).toEqual([["Anthropic", "tool_use", "tool_calls"], ["Anthropic", "end_turn", "stop"]]);
    // cost = tokens x pricing: (100+10+40)*1e-7 + 20*5e-7, then 200*1e-7 + 30*5e-7
    expect(rec.totalCostUsd).toBeCloseTo(150e-7 + 20 * 5e-7 + 200e-7 + 30 * 5e-7, 12);
  });
});

describe("anthropic response translation", () => {
  const chat = async (m: any) => createAnthropicClient({ sdk: mockSdk([m]).sdk }).chat(body("tools+schema"));
  it("tool_use -> tool_calls (+ text content), thinking ignored for content", async () => {
    const r = await chat(toolUseMsg());
    const c = r.json.choices[0];
    expect(c.message.content).toBe("checking");
    expect(c.message.tool_calls).toEqual([{ id: "tu1", type: "function", function: { name: "get_order_status", arguments: '{"order_id":"QX-48213"}' } }]);
    expect(c.finish_reason).toBe("tool_calls");
    expect(c.rawStopReason).toBe("tool_use");
    expect(r.json.usage.prompt_tokens).toBe(150);
    expect(r.json.usage.completion_tokens).toBe(20);
    expect(classifyFirst(r, ["get_order_status"]).outcome).toBe("tool_called");
  });
  it("text blocks joined; stop reasons mapped", async () => {
    const r = await chat(answerMsg);
    expect(r.json.choices[0].message.content).toBe('{"status":"held_at_customs","tracking_number":"ZK8-55107-T","eta_days":6}');
    expect(r.json.choices[0].finish_reason).toBe("stop");
    expect(classifyFirst(r, ["get_order_status"]).outcome).toBe("tool_missing");
    expect((await chat({ ...answerMsg, stop_reason: "max_tokens" })).json.choices[0].finish_reason).toBe("length");
    const ref = await chat({ ...answerMsg, stop_reason: "refusal" });
    expect(ref.json.choices[0].finish_reason).toBe("content_filter");
    expect(ref.json.choices[0].rawStopReason).toBe("refusal");
    expect(classifyFirst(ref, []).outcome).toBe("error_or_refusal");
  });
});

describe("anthropic error mapping", () => {
  const err = (E: any, status: number, msg: string, headers?: Record<string, string>) =>
    new E(status, { type: "error", error: { type: "x", message: msg } }, msg, new Headers(headers));
  const run = (e: Error) => createAnthropicClient({ sdk: mockSdk([e]).sdk }).chat(body("tools+schema"));
  it("429 with retry-after", async () => {
    const r = await run(err(Anthropic.RateLimitError, 429, "slow down", { "retry-after": "7" }));
    expect(r).toMatchObject({ ok: false, status: 429, retryAfterSec: 7 });
    expect(classifyFirst(r, []).outcome).toBe("rate_limited");
  });
  it("429 without retry-after", async () => {
    expect((await run(err(Anthropic.RateLimitError, 429, "slow down"))).retryAfterSec).toBeUndefined();
  });
  it("400 unsupported -> unsupported", async () => {
    const r = await run(err(Anthropic.BadRequestError, 400, "temperature is not supported for this model"));
    expect(r.status).toBe(400);
    expect(classifyFirst(r, []).outcome).toBe("unsupported");
  });
  it("other 400 -> error_or_refusal", async () => {
    const r = await run(err(Anthropic.BadRequestError, 400, "messages.0: bad shape"));
    expect(classifyFirst(r, []).outcome).toBe("error_or_refusal");
    expect(r.json.error.message).toContain("bad shape");
  });
  it("other API error keeps status; connection error is status 0", async () => {
    expect((await run(err(Anthropic.InternalServerError, 500, "oops"))).status).toBe(500);
    const c = await run(new Anthropic.APIConnectionError({ message: "ECONNRESET" }));
    expect(c).toMatchObject({ ok: false, status: 0 });
    expect(c.errorMessage).toMatch(/ECONNRESET/);
  });
});

describe("ollama", () => {
  it("request has no provider/usage fields; has temperature, max_tokens, tools, response_format, required", () => {
    const b = buildRequest("qwen3.6:35b-a3b", task, "tools+schema+required", [], 1, { provider: "ollama" }) as any;
    expect("provider" in b).toBe(false);
    expect("usage" in b).toBe(false);
    expect(b).toMatchObject({ temperature: 0.5, max_tokens: 4096, tool_choice: "required" });
    expect(b.tools).toBeDefined();
    expect(b.response_format.type).toBe("json_schema");
  });
  it("client: default base URL, no Authorization, no key needed", async () => {
    const seen: any[] = [];
    const f = async (url: string, init: any) => (seen.push({ url, init }), { status: 200, text: async () => "{}", headers: new Headers() });
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    const r = await createOllamaClient({ fetch: f }).chat({ model: "m" });
    expect(r.ok).toBe(true);
    expect(seen[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen[0].init.headers.Authorization).toBeUndefined();
    process.env.OLLAMA_BASE_URL = "http://box:1234/v1/";
    await createOllamaClient({ fetch: f }).chat({ model: "m" });
    expect(seen[1].url).toBe("http://box:1234/v1/chat/completions");
    delete process.env.OLLAMA_BASE_URL;
  });
  it("openrouter client still requires a key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(createClient({ fetch: async () => ({}) as any }).chat({})).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

const toolRes = (): ChatResult => ({ ok: true, status: 200, latencyMs: 1, rawText: "", json: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "get_order_status", arguments: '{"order_id":"QX-48213"}' } }] } }] } });
const ansRes = (): ChatResult => ({ ok: true, status: 200, latencyMs: 1, rawText: "", json: { choices: [{ finish_reason: "stop", message: { content: '{"status":"held_at_customs","tracking_number":"ZK8-55107-T","eta_days":6}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } } });

function setup(models: any[], over: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ct-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ models }));
  const opts: RunOptions = {
    models: "all-free", conditions: ["tools-only"], tasks: ["t01"], reps: 1,
    out: join(dir, "runs.jsonl"), freeLimit: 900, yes: false, dryRun: false,
    modelsFile: join(dir, "models.json"), quotaFile: join(dir, "quota.json"), intervalMs: 3100, ...over,
  };
  const calls: any[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse("2026-11-24T10:00:00Z");
  const client: Client = { chat: async (b: any) => (calls.push(b), b.messages.length === 2 ? toolRes() : ansRes()), getKeyInfo: async () => ({}) };
  const logs: string[] = [];
  const deps = { client, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; }, now: () => clock, log: (s: string) => void logs.push(s), tasks: TASKS };
  const lines = () => readFileSync(opts.out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionRecord);
  return { opts, deps, calls, sleeps, lines, logs, dir };
}

describe("runner: providers", () => {
  const ollama = { id: "gemma4:26b-a4b", provider: "ollama", role: "local", pricing: { prompt: "0", completion: "0" } };
  const claude = { id: "claude-haiku-5-5", provider: "anthropic", role: "closed-control", pricing: { prompt: "0.0000001", completion: "0.0000005" } };
  it("ollama: no quota counting, no rate-limit sleeps, no gate, cost 0, no provider/usage in body", async () => {
    const s = setup([ollama], { models: "local" });
    const r = await runBench(s.opts, s.deps);
    expect(r.exitCode).toBe(0);
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps).toEqual([]);
    expect(() => readFileSync(s.opts.quotaFile, "utf8")).toThrow();
    for (const b of s.calls) { expect("provider" in b).toBe(false); expect("usage" in b).toBe(false); }
    expect(s.lines()[0]).toMatchObject({ provider: "ollama", totalCostUsd: 0, requireParameters: false });
    expect(s.lines()[0]!.requests[0]!.providerName).toBe("Ollama");
  });
  it("anthropic is paid: gated by --max-usd and --yes; spend tracked", async () => {
    const s = setup([claude], { models: "anthropic" });
    expect((await runBench(s.opts, s.deps)).exitCode).toBe(2);
    expect((await runBench({ ...s.opts, maxUsd: 1 }, s.deps)).exitCode).toBe(2);
    expect(s.calls).toHaveLength(0);
    const r = await runBench({ ...s.opts, maxUsd: 1, yes: true }, s.deps);
    expect(r.exitCode).toBe(0);
    expect(r.spentUsd).toBeCloseTo(1000e-7 + 100 * 5e-7, 12);
    expect(() => readFileSync(s.opts.quotaFile, "utf8")).toThrow(); // not free quota
  });
  it("selectors: controls = anthropic; local = ollama; all-free excludes both", async () => {
    const free = { id: "a/x:free", provider: "openrouter", role: "free" };
    const run = async (sel: string) => { const s = setup([free, claude, ollama], { models: sel, dryRun: true }); await runBench(s.opts, s.deps); return s.logs.join("\n"); };
    expect(await run("controls")).toMatch(/total: 1 /);
    expect(await run("anthropic")).toMatch(/total: 1 /);
    expect(await run("local")).toMatch(/total: 1 /);
    expect(await run("all-free")).toMatch(/total: 1 /);
    expect(await run("claude-haiku-5-5,gemma4:26b-a4b")).toMatch(/total: 2 /);
  });
});

describe("--no-require-parameters", () => {
  const free = { id: "a/x:free", provider: "openrouter", role: "free" };
  it("default sends provider.require_parameters and records true", async () => {
    const s = setup([free]);
    await runBench(s.opts, s.deps);
    expect(s.calls[0].provider).toEqual({ require_parameters: true });
    expect(s.lines()[0]!.requireParameters).toBe(true);
  });
  it("flag omits the provider field and records false", async () => {
    const s = setup([free], { noRequireParameters: true });
    await runBench(s.opts, s.deps);
    for (const b of s.calls) expect("provider" in b).toBe(false);
    expect(s.calls[0].usage).toEqual({ include: true });
    expect(s.lines()[0]!.requireParameters).toBe(false);
  });
  it("dry-run reports the setting", async () => {
    const s = setup([free], { dryRun: true, noRequireParameters: true });
    await runBench(s.opts, s.deps);
    expect(s.logs.join("\n")).toMatch(/require_parameters: OFF/);
    const t = setup([free], { dryRun: true });
    await runBench(t.opts, t.deps);
    expect(t.logs.join("\n")).toMatch(/require_parameters: ON/);
  });
});
