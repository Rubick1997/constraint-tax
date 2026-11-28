import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { wilson } from "../report.js";
import type { DemoRecord } from "./arms.js";
import { DEFAULT_OUT } from "./run.js";

export const DEMO_START = "<!-- demo:start -->";
export const DEMO_END = "<!-- demo:end -->";

export function loadDemoRecords(file: string): DemoRecord[] {
  const map = new Map<string, DemoRecord>();
  if (!existsSync(file)) return [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DemoRecord;
      map.set(r.key, r);
    } catch {
      /* torn line */
    }
  }
  return [...map.values()];
}

const armRank = (a: string) => (a === "sonnet-solo" ? 0 : a === "haiku-solo" ? 1 : a.startsWith("worker-solo") ? 2 : 3);
export const sortArms = (arms: string[]) => [...arms].sort((a, b) => armRank(a) - armRank(b) || a.localeCompare(b));

export interface Stats {
  arm: string;
  split: "all" | "chain" | "bulky";
  n: number;
  correct: number;
  accuracy: number;
  lo: number;
  hi: number;
  fieldScore: number;
  claudeCostUsd: number;
  claudeTokens: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCalls: number;
  latencyMs: number;
  workerCalls: number;
  errors: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function stats(rows: DemoRecord[], arm: string, split: Stats["split"]): Stats | null {
  const r = rows.filter((x) => x.arm === arm && (split === "all" || x.kind === split));
  if (!r.length) return null;
  const w = wilson(r.filter((x) => x.correct).length, r.length)!;
  return {
    arm,
    split,
    n: r.length,
    correct: r.filter((x) => x.correct).length,
    accuracy: w.p,
    lo: w.lo,
    hi: w.hi,
    fieldScore: mean(r.map((x) => x.fieldScore)),
    claudeCostUsd: mean(r.map((x) => x.claudeCostUsd)),
    claudeTokens: mean(r.map((x) => x.claudeInputTokens + x.claudeOutputTokens)),
    claudeInputTokens: mean(r.map((x) => x.claudeInputTokens)),
    claudeOutputTokens: mean(r.map((x) => x.claudeOutputTokens)),
    claudeCalls: mean(r.map((x) => x.claudeCalls)),
    latencyMs: mean(r.map((x) => x.totalLatencyMs)),
    workerCalls: mean(r.map((x) => x.workerCalls)),
    errors: r.filter((x) => x.error).length,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const tok = (x: number) => Math.round(x).toLocaleString("en-US");

const HEADER =
  "| arm | n | accuracy (Wilson 95% CI) | mean field score | Claude $/task | Claude tokens/task | mean latency (s) | worker calls/task |\n|---|---|---|---|---|---|---|---|";
const row = (s: Stats) =>
  `| ${s.arm} | ${s.n} | ${pct(s.accuracy)} [${pct(s.lo)}-${pct(s.hi)}] (${s.correct}/${s.n}) | ${s.fieldScore.toFixed(2)} | ${usd(s.claudeCostUsd)} | ${tok(s.claudeTokens)} | ${(s.latencyMs / 1000).toFixed(1)} | ${s.workerCalls.toFixed(1)} |`;

/** "brain-worker:<m> vs sonnet-solo: X% of the Claude cost at Y vs Z accuracy" for every brain-worker arm. */
export function headlines(rows: DemoRecord[]): string[] {
  const base = stats(rows, "sonnet-solo", "all");
  const out: string[] = [];
  for (const arm of sortArms([...new Set(rows.map((r) => r.arm))]).filter((a) => a.startsWith("brain-worker"))) {
    const s = stats(rows, arm, "all")!;
    if (!base) {
      out.push(`${arm}: no sonnet-solo rows to compare against yet.`);
      continue;
    }
    const share = base.claudeCostUsd > 0 ? `${Math.round((s.claudeCostUsd / base.claudeCostUsd) * 100)}%` : "n/a";
    out.push(`${arm} vs sonnet-solo: ${share} of the Claude cost at ${pct(s.accuracy)} vs ${pct(base.accuracy)} accuracy.`);
  }
  return out;
}

export function renderMarkdown(rows: DemoRecord[]): string {
  const arms = sortArms([...new Set(rows.map((r) => r.arm))]);
  const lines: string[] = ["# Brain/worker demo", ""];
  if (!rows.length) return lines.concat(["No sessions recorded yet. Run `pnpm demo` first.", ""]).join("\n");
  const tasks = new Set(rows.map((r) => r.task));
  lines.push(
    `${rows.length} sessions, ${tasks.size} tasks, ${arms.length} arms. Local workers ran at temperature 0; Claude arms used default sampling and thinking. Claude cost is computed from returned token usage (Sonnet 5.5 $2 in / $10 out per MTok, Haiku 5.5 $0.10 / $0.50 per MTok); local worker calls are free, so their $ column is zero.`,
    "",
  );
  lines.push("## Headline", "", ...headlines(rows).map((h) => `- ${h}`), "");
  for (const split of ["all", "chain", "bulky"] as const) {
    lines.push(
      `## ${split === "all" ? "All tasks" : split === "chain" ? "Chain tasks (3-6 tool calls, small outputs)" : "Bulky tasks (one tool returns a large payload)"}`,
      "",
      HEADER,
    );
    for (const a of arms) {
      const s = stats(rows, a, split);
      if (s) lines.push(row(s));
    }
    lines.push("");
  }
  const bw = rows.filter((r) => r.arm.startsWith("brain-worker"));
  if (bw.length) lines.push("## Brain-worker detail", "", `Re-runs used: ${bw.filter((r) => r.rerunUsed).length}/${bw.length} sessions. Sessions with an error: ${bw.filter((r) => r.error).length}.`, "");
  const errs = rows.filter((r) => r.error).length;
  if (errs) lines.push(`${errs} of ${rows.length} sessions recorded an error (counted as incorrect).`, "");
  return lines.join("\n");
}

export function renderCsv(rows: DemoRecord[]): string {
  const head =
    "arm,split,n,correct,accuracy,ci_lo,ci_hi,mean_field_score,claude_usd_per_task,claude_tokens_per_task,claude_input_tokens,claude_output_tokens,claude_calls,mean_latency_ms,worker_calls,errors";
  const lines = [head];
  const cell = (c: string | number) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
  for (const a of sortArms([...new Set(rows.map((r) => r.arm))]))
    for (const split of ["all", "chain", "bulky"] as const) {
      const s = stats(rows, a, split);
      if (!s) continue;
      lines.push(
        [
          s.arm,
          s.split,
          s.n,
          s.correct,
          s.accuracy.toFixed(4),
          s.lo.toFixed(4),
          s.hi.toFixed(4),
          s.fieldScore.toFixed(4),
          s.claudeCostUsd.toFixed(6),
          Math.round(s.claudeTokens),
          Math.round(s.claudeInputTokens),
          Math.round(s.claudeOutputTokens),
          s.claudeCalls.toFixed(2),
          Math.round(s.latencyMs),
          s.workerCalls.toFixed(2),
          s.errors,
        ]
          .map(cell)
          .join(","),
      );
    }
  return lines.join("\n") + "\n";
}

/** Compact block for the README: headline bullets plus the all-tasks table. */
export function readmeBlock(rows: DemoRecord[]): string {
  const arms = sortArms([...new Set(rows.map((r) => r.arm))]);
  if (!rows.length) return "_No results yet. Run `pnpm demo` and `pnpm demo:summary`._";
  const table = arms.map((a) => stats(rows, a, "all")).filter((s): s is Stats => !!s).map(row);
  return [...headlines(rows).map((h) => `- ${h}`), "", HEADER, ...table, "", "Full tables: [`results/demo.md`](results/demo.md), [`results/demo.csv`](results/demo.csv)."].join("\n");
}

export function fillReadme(readme: string, block: string): string | null {
  const a = readme.indexOf(DEMO_START);
  const b = readme.indexOf(DEMO_END);
  if (a < 0 || b < a) return null;
  return `${readme.slice(0, a + DEMO_START.length)}\n${block}\n${readme.slice(b)}`;
}

function main() {
  const { values } = parseArgs({
    options: {
      in: { type: "string", default: DEFAULT_OUT },
      md: { type: "string", default: "results/demo.md" },
      csv: { type: "string", default: "results/demo.csv" },
      readme: { type: "string", default: "README.md" },
    },
  });
  const rows = loadDemoRecords(values.in!);
  mkdirSync(dirname(values.md!), { recursive: true });
  writeFileSync(values.md!, renderMarkdown(rows));
  writeFileSync(values.csv!, renderCsv(rows));
  console.log(`wrote ${values.md} and ${values.csv} (${rows.length} sessions)`);
  if (existsSync(values.readme!)) {
    const filled = fillReadme(readFileSync(values.readme!, "utf8"), readmeBlock(rows));
    if (filled) {
      writeFileSync(values.readme!, filled);
      console.log(`updated ${values.readme}`);
    } else console.log(`README has no ${DEMO_START} ... ${DEMO_END} markers; left untouched`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
