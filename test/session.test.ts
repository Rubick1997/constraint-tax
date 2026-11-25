import { describe, expect, it } from "vitest";
import { runSession } from "../src/session.js";
import { buildRequest } from "../src/conditions.js";
import { TASKS } from "../src/tasks/index.js";
import type { ChatResult } from "../src/types.js";

const task = TASKS[0]!;
const ok = (message: any, extra: any = {}): ChatResult => ({
  ok: true, status: 200, latencyMs: 10, rawText: "",
  json: { choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }, ...extra },
});
const toolCall = ok({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_order_status", arguments: JSON.stringify({ order_id: "qx-48213 " }) } }] }, { provider: "P" });
const answer = ok({ role: "assistant", content: "```json\n" + JSON.stringify({ status: "held_at_customs", tracking_number: "ZK8-55107-T", eta_days: 6 }) + "\n```" });

describe("buildRequest", () => {
  it("required only on turn 1 of tools+schema+required; none elsewhere", () => {
    const m: any[] = [];
    expect(buildRequest("m", task, "tools+schema+required", m, 1).tool_choice).toBe("required");
    expect(buildRequest("m", task, "tools+schema+required", m, 2).tool_choice).toBeUndefined();
    for (const c of ["tools-only", "schema-only", "tools+schema"] as const) expect(buildRequest("m", task, c, m, 1).tool_choice).toBeUndefined();
    const b = buildRequest("m", task, "schema-only", m, 1);
    expect(b.tools).toBeUndefined();
    expect((b.response_format as any).json_schema.strict).toBe(true);
    expect(buildRequest("m", task, "tools-only", m, 1).response_format).toBeUndefined();
    expect(b.provider).toEqual({ require_parameters: true });
  });
});

describe("runSession", () => {
  it("executes tool, feeds result back, scores e2e", async () => {
    const bodies: any[] = [];
    const replies = [toolCall, answer];
    const rec = await runSession({ chat: async (b) => (bodies.push(JSON.parse(JSON.stringify(b))), replies.shift()!) }, { model: "m", condition: "tools+schema+required", task, rep: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tool_choice).toBe("required");
    expect(bodies[1].tool_choice).toBeUndefined();
    const msgs = bodies[1].messages;
    expect(msgs.at(-2).role).toBe("assistant");
    const toolMsg = msgs.at(-1);
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("c1");
    expect(JSON.parse(toolMsg.content).tracking_number).toBe("ZK8-55107-T");
    expect(rec).toMatchObject({ firstOutcome: "tool_called", toolCalled: true, toolCorrect: true, finalJsonParsed: true, schemaValid: true, answerCorrect: true, e2eSuccess: true });
    expect(rec.requests[0]!.providerName).toBe("P");
    expect(rec.totalCostUsd).toBeCloseTo(0.002);
  });
  it("unknown tool and bad args produce error results; caps at 4 requests", async () => {
    const bad = ok({ role: "assistant", content: null, tool_calls: [
      { id: "a", type: "function", function: { name: "nope", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "get_order_status", arguments: "{bad" } },
    ] });
    const bodies: any[] = [];
    const rec = await runSession({ chat: async (b) => (bodies.push(JSON.parse(JSON.stringify(b))), bad) }, { model: "m", condition: "tools+schema", task, rep: 1 });
    expect(bodies).toHaveLength(4);
    const tools = bodies[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(tools).toEqual([JSON.stringify({ error: "unknown tool" }), JSON.stringify({ error: "invalid arguments" })]);
    expect(rec.e2eSuccess).toBe(false);
  });
  it("schema-only gives e2eSuccess null; no tool call when answer is guessed", async () => {
    const rec = await runSession({ chat: async () => answer }, { model: "m", condition: "schema-only", task, rep: 1 });
    expect(rec.e2eSuccess).toBeNull();
    expect(rec.toolCalled).toBe(false);
  });
});
