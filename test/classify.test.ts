import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyFirst, isTransient } from "../src/classify.js";
import type { ChatResult } from "../src/types.js";

const fx = (n: string): ChatResult => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
  return { ok: f.status >= 200 && f.status < 300, status: f.status, json: f.json, rawText: JSON.stringify(f.json), latencyMs: 5 };
};
const names = ["get_order_status", "get_invoice"];

describe("classifyFirst", () => {
  it("tool present", () => expect(classifyFirst(fx("tool_present"), names).outcome).toBe("tool_called"));
  it("tool missing", () => {
    const c = classifyFirst(fx("tool_missing"), names);
    expect(c.outcome).toBe("tool_missing");
    expect(c.toolCallInText).toBe(false);
  });
  it("429", () => expect(classifyFirst(fx("rate_limited"), names).outcome).toBe("rate_limited"));
  it("404 unsupported keeps raw message", () => {
    const c = classifyFirst(fx("unsupported_404"), names);
    expect(c.outcome).toBe("unsupported");
    expect(c.message).toMatch(/No endpoints found/);
  });
  it("200 with error object", () => {
    const c = classifyFirst(fx("error_in_200"), names);
    expect(c.outcome).toBe("error_or_refusal");
    expect(c.message).toMatch(/upstream exploded/);
  });
  it("refusal", () => expect(classifyFirst(fx("refusal"), names).outcome).toBe("error_or_refusal"));
  it("tool call printed as text", () => {
    const c = classifyFirst(fx("tool_in_text"), names);
    expect(c.outcome).toBe("tool_missing");
    expect(c.toolCallInText).toBe(true);
  });
  it("network error and 500 are errors; plain 404 is not unsupported", () => {
    expect(classifyFirst({ ok: false, status: 0, json: null, rawText: "", latencyMs: 1, errorMessage: "x" }, names).outcome).toBe("error_or_refusal");
    expect(classifyFirst({ ok: false, status: 404, json: { error: { message: "model gone" } }, rawText: "", latencyMs: 1 }, names).outcome).toBe("error_or_refusal");
  });
  it("isTransient", () => {
    const rq = (status: number) => ({ requests: [{ status }] as any });
    expect(isTransient(rq(429))).toBe(true);
    expect(isTransient(rq(503))).toBe(true);
    expect(isTransient(rq(0))).toBe(true);
    expect(isTransient(rq(200))).toBe(false);
    expect(isTransient(rq(404))).toBe(false);
  });
});
