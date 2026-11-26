import { describe, expect, it } from "vitest";
import { loadRecords } from "../src/summarize.js";
import {
  buildCells,
  cellsCsv,
  cleanMessage,
  csvEscape,
  failureClass,
  isInvented,
  renderHeadline,
  replaceMarkedBlock,
  sessionsCsv,
  toRows,
  wilson,
  type Row,
} from "../src/report.js";
import type { RequestRecord, SessionRecord } from "../src/types.js";

const req = (o: Partial<RequestRecord> = {}): RequestRecord => ({
  status: 200, latencyMs: 10, finishReason: "stop", toolCallNames: [], usage: null, cost: 0, errorMessage: null,
  providerName: null, retryAfterSec: null, rawStopReason: null, attempt: 1, retryOf: null, rateLimited: false, ...o,
});

function rec(o: Partial<SessionRecord> & { model: string; condition: SessionRecord["condition"]; taskId: string; rep?: number }): SessionRecord {
  const rep = o.rep ?? 1;
  return {
    key: `${o.model}|${o.condition}|${o.taskId}|${rep}`, provider: "openrouter", requireParameters: true, startedAt: "2026-11-25T10:00:00Z",
    requests: [req()], firstOutcome: "tool_called", toolCalled: true, toolCorrect: true, toolCallInText: false, finalJsonParsed: true,
    schemaValid: true, answerCorrect: true, e2eSuccess: true, rateLimitedAttempts: 0, totalLatencyMs: 100, totalCostUsd: 0,
    finalContent: "{}", rawError: null, rep, ...o,
  } as SessionRecord;
}
const silent = (model: string, taskId: string, condition: SessionRecord["condition"] = "tools+schema"): SessionRecord =>
  rec({ model, condition, taskId, firstOutcome: "tool_missing", toolCalled: false, toolCorrect: false, answerCorrect: false, e2eSuccess: false, finalContent: '{"status":"x","tracking_number":"1Z999","eta_days":3}' });
const rows = (recs: SessionRecord[]): Row[] => toRows(new Map([["main-free.jsonl", recs]]));

describe("wilson", () => {
  it("matches known values", () => {
    const w = wilson(0, 30)!;
    expect(w.lo).toBe(0);
    expect(w.hi).toBeCloseTo(0.1135, 3);
    const a = wilson(30, 30)!;
    expect(a.lo).toBeCloseTo(0.8865, 3);
    expect(a.hi).toBe(1);
    const m = wilson(15, 30)!;
    expect(m.lo).toBeCloseTo(0.3315, 3);
    expect(m.hi).toBeCloseTo(0.6685, 3);
  });
  it("is null for n=0", () => expect(wilson(0, 0)).toBeNull());
});

describe("loadRecords dedupe", () => {
  it("keeps the last record for a duplicated key", () => {
    const a = rec({ model: "m", condition: "tools-only", taskId: "t01", firstOutcome: "rate_limited", toolCalled: false });
    const b = rec({ model: "m", condition: "tools-only", taskId: "t01" });
    const out = loadRecords([JSON.stringify(a), "{torn", JSON.stringify(b)].join("\n"));
    expect(out).toHaveLength(1);
    expect(out[0]!.firstOutcome).toBe("tool_called");
  });
});

describe("aggregation", () => {
  it("excludes skipped and 429-only sessions from rates but reports them", () => {
    const recs = [
      rec({ model: "m", condition: "tools+schema", taskId: "t01" }),
      silent("m", "t02"),
      rec({ model: "m", condition: "tools+schema", taskId: "t03", firstOutcome: "rate_limited", toolCalled: false, requests: [req({ status: 429, rateLimited: true })] }),
      rec({ model: "m", condition: "tools+schema", taskId: "t04", firstOutcome: "skipped", skipped: "unsupported-cell", requests: [], toolCalled: false }),
    ];
    const [c] = buildCells(rows(recs), () => true);
    expect(c).toMatchObject({ total: 4, n: 2, skipped: 1, rateLimited: 1, toolCalled: 1, e2e: 1 });
  });
  it("classifies silent drops, invented values and other failures", () => {
    const s = silent("m", "t01");
    expect(failureClass(s)).toBe("silent_drop");
    expect(isInvented(s)).toBe(true);
    expect(failureClass({ ...s, schemaValid: false })).toBe("tool_missing_other");
    expect(failureClass({ ...s, firstOutcome: "error_or_refusal" })).toBe("error_or_refusal");
    expect(failureClass({ ...s, firstOutcome: "unsupported" })).toBe("unsupported");
    expect(failureClass(rec({ model: "m", condition: "tools-only", taskId: "t01" }))).toBe("tool_called");
    expect(isInvented({ ...s, answerCorrect: true })).toBe(false);
  });
});

describe("csv", () => {
  it("escapes commas, quotes and newlines", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("l1\nl2")).toBe('"l1\nl2"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(0)).toBe("0");
  });
  it("writes one row per session plus header", () => {
    const rs = rows([rec({ model: "weird,model", condition: "tools-only", taskId: "t01" })]);
    const lines = sessionsCsv(rs).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"weird,model"');
    expect(cellsCsv(buildCells(rs, () => true), []).trimEnd().split("\n")).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("strips URLs and truncates messages", () => {
    expect(cleanMessage("bad see https://example.com/x?y=1 now")).toBe("bad see now");
    expect(cleanMessage("x".repeat(300))).toHaveLength(160);
  });
  it("replaces only the marked block", () => {
    const t = "a\n<!-- s -->\nold\n<!-- e -->\nb";
    expect(replaceMarkedBlock(t, "<!-- s -->", "<!-- e -->", "new")).toBe("a\n<!-- s -->\nnew\n<!-- e -->\nb");
    expect(replaceMarkedBlock("none", "<!-- s -->", "<!-- e -->", "new")).toBeNull();
  });
});

describe("headline table", () => {
  it("renders per model and arm", () => {
    const free: SessionRecord[] = [];
    for (const c of ["tools-only", "tools+schema", "tools+schema+required"] as const)
      for (let i = 1; i <= 4; i++) {
        const id = `t0${i}`;
        free.push(c === "tools-only" || (c === "tools+schema+required" && i <= 2) ? rec({ model: "a/free:free", condition: c, taskId: id }) : silent("a/free:free", id, c));
      }
    const claude = ["tools-only", "tools+schema", "tools+schema+required"].map((c) =>
      rec({ model: "claude-x", provider: "anthropic", condition: c as any, taskId: "t01" }));
    const unsup = rec({ model: "b/flint:free", condition: "tools+schema", taskId: "t01", firstOutcome: "unsupported", toolCalled: false, e2eSuccess: false });
    const blocked = rec({ model: "c/gemma:free", condition: "tools-only", taskId: "t01", firstOutcome: "rate_limited", toolCalled: false, requests: [req({ status: 429, rateLimited: true })] });
    const cells = buildCells(rows([...free, ...claude, unsup, blocked]), () => true);
    expect(renderHeadline(cells, ["a/free:free", "b/flint:free", "c/gemma:free", "claude-x"])).toMatchInlineSnapshot(`
      "| model | arm | tools-only TIR | tools+schema TIR | +required TIR |
      |---|---|---|---|---|
      | a/free:free | Free OpenRouter endpoints | 100% (4/4) | 0% (0/4) | 50% (2/4) |
      | b/flint:free | Free OpenRouter endpoints | - | unsupported (n=1) | - |
      | c/gemma:free | Free OpenRouter endpoints | no data (429) | - | - |
      | claude-x | Claude control (Anthropic API) | 100% (1/1) | 100% (1/1) | 100% (1/1) |"
    `);
  });
});
