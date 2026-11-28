import { beforeEach, describe, expect, it } from "vitest";
import { getAutoStatus, resetAutoMemory, withToolsAndSchema, type ChatFn, type Options } from "../packages/tool-schema-safe/src/index.js";

const schema = { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false };
const tools = [{ type: "function" as const, function: { name: "lookup", description: "d", parameters: { type: "object", properties: { id: { type: "string" } } } } }];
const toolMsg = (name = "lookup", args: unknown = { id: "1" }) => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const text = (content: string) => ({ role: "assistant", content });
const reply = (message: any) => ({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] });
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function script(steps: (any | Error)[]) {
  const bodies: any[] = [];
  const chat: ChatFn = async (b) => {
    bodies.push(JSON.parse(JSON.stringify(b)));
    const s = steps.shift();
    if (!s) throw new Error("script exhausted");
    if (s instanceof Error) throw s;
    return typeof s === "function" ? s(b) : s;
  };
  return { chat, bodies };
}
const base = (strategy: Options["strategy"], over: Partial<Options> = {}): Options => ({
  model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "q" }], tools, schema, strategy,
  executeTool: (name, args: any) => ({ status: `found-${name}-${args.id}` }), extraBody: { temperature: 0.1 }, ...over,
});

beforeEach(() => resetAutoMemory());

describe("native", () => {
  it("tool call -> tool result -> final fenced JSON, schema sent with tools", async () => {
    const s = script([reply(toolMsg()), reply(text('```json\n{"status":"ok"}\n```'))]);
    const r = await withToolsAndSchema(s.chat, base("native"));
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.validated).toBe(true);
    expect(r.calls).toBe(2);
    expect(r.toolCalls).toEqual([{ name: "lookup", args: { id: "1" }, result: { status: "found-lookup-1" } }]);
    expect(s.bodies[0].tools).toBeDefined();
    expect(s.bodies[0].response_format.json_schema.strict).toBe(true);
    expect(s.bodies[0].temperature).toBe(0.1);
    expect(s.bodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });
  it("reports schema violations", async () => {
    const s = script([reply(toolMsg()), reply(text('{"status":5}'))]);
    const r = await withToolsAndSchema(s.chat, base("native"));
    expect(r.validated).toBe(false);
    expect(r.validationErrors?.length).toBeGreaterThan(0);
  });
  it("maxTurns bounds tool rounds", async () => {
    const s = script(Array.from({ length: 5 }, () => reply(toolMsg())));
    const r = await withToolsAndSchema(s.chat, base("native", { maxTurns: 2 }));
    expect(r.calls).toBe(3);
    expect(r.answer).toBeNull();
    expect(r.error).toMatch(/maxTurns/);
  });
});

describe("two-phase", () => {
  it("phase 1 has tools and no schema; phase 2 has schema, no tools, and keeps phase-1 text", async () => {
    const s = script([reply(toolMsg()), reply(text("The order is ok.")), reply(text('{"status":"ok"}'))]);
    const r = await withToolsAndSchema(s.chat, base("two-phase"));
    expect(r.calls).toBe(3);
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.validated).toBe(true);
    expect(r.strategyUsed).toBe("two-phase");
    for (const i of [0, 1]) {
      expect(s.bodies[i].tools).toBeDefined();
      expect(s.bodies[i].response_format).toBeUndefined();
    }
    const p2 = s.bodies[2];
    expect(p2.tools).toBeUndefined();
    expect(p2.tool_choice).toBeUndefined();
    expect(p2.response_format.type).toBe("json_schema");
    const roles = p2.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(p2.messages[4].content).toBe("The order is ok.");
  });
});

describe("answer-as-tool", () => {
  it("submit path: arguments are the answer and submit_answer is not executed", async () => {
    const executed: string[] = [];
    const s = script([reply(toolMsg()), reply(toolMsg("submit_answer", { status: "ok" }))]);
    const r = await withToolsAndSchema(s.chat, base("answer-as-tool", { executeTool: (n, a: any) => (executed.push(n), { status: "x" }) }));
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.validated).toBe(true);
    expect(r.calls).toBe(2);
    expect(executed).toEqual(["lookup"]);
    expect(r.toolCalls.map((c) => c.name)).toEqual(["lookup"]);
    const b = s.bodies[0];
    expect(b.response_format).toBeUndefined();
    expect(b.tools.map((t: any) => t.function.name)).toEqual(["lookup", "submit_answer"]);
    expect(b.tools[1].function.parameters).toEqual(schema);
    expect(b.messages[0].content).toMatch(/submit_answer/);
  });
  it("nudge path: plain text gets one nudge, then submit", async () => {
    const s = script([reply(toolMsg()), reply(text("It is ok")), reply(toolMsg("submit_answer", { status: "ok" }))]);
    const r = await withToolsAndSchema(s.chat, base("answer-as-tool"));
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.calls).toBe(3);
    expect(s.bodies[2].messages.at(-1)).toMatchObject({ role: "user" });
    expect(s.bodies[2].messages.at(-1).content).toMatch(/submit_answer/);
  });
  it("last resort: still plain text after the nudge -> parse JSON from text", async () => {
    const s = script([reply(text("no")), reply(text('{"status":"ok"}'))]);
    const r = await withToolsAndSchema(s.chat, base("answer-as-tool"));
    expect(r.calls).toBe(2);
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.validated).toBe(true);
  });
  it("gives up with an error when the text is not JSON either", async () => {
    const s = script([reply(text("no")), reply(text("still no"))]);
    const r = await withToolsAndSchema(s.chat, base("answer-as-tool"));
    expect(r.answer).toBeNull();
    expect(r.validated).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe("auto", () => {
  it("falls back to answer-as-tool after a silent drop, remembers it, then goes straight to answer-as-tool", async () => {
    const s = script([
      reply(text('{"status":"guess"}')), // native: tools offered, none called
      reply(toolMsg()), reply(toolMsg("submit_answer", { status: "ok" })), // answer-as-tool rerun
    ]);
    const r = await withToolsAndSchema(s.chat, base("auto"));
    expect(r.fellBack).toBe(true);
    expect(r.strategyUsed).toBe("answer-as-tool");
    expect(r.calls).toBe(3);
    expect(r.answer).toEqual({ status: "ok" });
    expect(r.toolCalls.map((c) => c.name)).toEqual(["lookup"]);
    expect(s.bodies[1].response_format).toBeUndefined();
    expect(getAutoStatus("m")).toBe("native-broken");

    const s2 = script([reply(toolMsg()), reply(toolMsg("submit_answer", { status: "ok" }))]);
    const r2 = await withToolsAndSchema(s2.chat, base("auto"));
    expect(r2.fellBack).toBeUndefined();
    expect(r2.strategyUsed).toBe("answer-as-tool");
    expect(r2.calls).toBe(2);
    expect(s2.bodies[0].response_format).toBeUndefined();
    expect(s2.bodies[0].tools.map((t: any) => t.function.name)).toContain("submit_answer");
  });
  it("keeps native when the tool is called", async () => {
    const s = script([reply(toolMsg()), reply(text('{"status":"ok"}'))]);
    const r = await withToolsAndSchema(s.chat, base("auto"));
    expect(r.strategyUsed).toBe("native");
    expect(r.fellBack).toBeUndefined();
    expect(r.calls).toBe(2);
    expect(getAutoStatus("m")).toBe("native-ok");
  });
  it("a 4xx on native triggers fallback", async () => {
    const s = script([httpErr(400), reply(toolMsg()), reply(toolMsg("submit_answer", { status: "ok" }))]);
    const r = await withToolsAndSchema(s.chat, base("auto"));
    expect(r.fellBack).toBe(true);
    expect(r.strategyUsed).toBe("answer-as-tool");
    expect(r.calls).toBe(3);
    expect(r.validated).toBe(true);
    expect(getAutoStatus("m")).toBe("native-broken");
  });
  it("429 and 5xx do not mark the model broken", async () => {
    for (const code of [429, 503]) {
      resetAutoMemory();
      const r = await withToolsAndSchema(script([httpErr(code)]).chat, base("auto"));
      expect(r.fellBack).toBeUndefined();
      expect(r.error).toMatch(String(code));
      expect(getAutoStatus("m")).toBeUndefined();
    }
  });
});
