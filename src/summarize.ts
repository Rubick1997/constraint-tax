import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { SessionRecord } from "./types.js";

export function loadRecords(text: string): SessionRecord[] {
  const byKey = new Map<string, SessionRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SessionRecord;
      byKey.set(r.key, r); // later lines (retries) win
    } catch {
      /* ignore torn line */
    }
  }
  return [...byKey.values()];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (k: number, d: number) => (d ? `${k}/${d} (${Math.round((100 * k) / d)}%)` : "-");

export function summarize(records: SessionRecord[]): string {
  const groups = new Map<string, SessionRecord[]>();
  for (const r of records) {
    const g = `${r.model}\u0000${r.condition}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(r);
  }
  const rows = [
    "| model | condition | n | tool_called | tool_missing | error_or_refusal | unsupported | rate_limited | 429s | skipped | TIR | toolCorrect | schemaValid | e2e | toolCallInText | median latency ms | cost USD |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const g of [...groups.keys()].sort()) {
    const rs = groups.get(g)!;
    const [model, condition] = g.split("\u0000");
    const c = (o: string) => rs.filter((r) => r.firstOutcome === o).length;
    const valid = rs.filter((r) => r.firstOutcome !== "rate_limited" && r.firstOutcome !== "skipped");
    const d = valid.length;
    const schemaOnly = condition === "schema-only";
    const lat = median(valid.map((r) => r.totalLatencyMs));
    rows.push(
      [
        model,
        condition,
        rs.length,
        c("tool_called"),
        c("tool_missing"),
        c("error_or_refusal"),
        c("unsupported"),
        c("rate_limited"),
        rs.reduce((s, r) => s + (r.rateLimitedAttempts ?? r.requests.filter((q) => q.status === 429).length), 0),
        c("skipped"),
        schemaOnly ? "-" : pct(valid.filter((r) => r.firstOutcome === "tool_called").length, d),
        schemaOnly ? "-" : pct(valid.filter((r) => r.toolCorrect).length, d),
        pct(valid.filter((r) => r.schemaValid).length, d),
        schemaOnly ? "-" : pct(valid.filter((r) => r.e2eSuccess === true).length, d),
        rs.filter((r) => r.toolCallInText).length,
        lat === null ? "-" : Math.round(lat),
        rs.reduce((s, r) => s + r.totalCostUsd, 0).toFixed(4),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  return rows.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: pnpm summarize <runs.jsonl>");
    process.exit(1);
  }
  console.log(summarize(loadRecords(readFileSync(file, "utf8"))));
}
