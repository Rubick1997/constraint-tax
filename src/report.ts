import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRecords } from "./summarize.js";
import { ALL_CONDITIONS, WORKAROUND_CONDITIONS, isWorkaround, type SessionRecord } from "./types.js";

/** Sessions per model and condition in the main design (15 tasks x 2 reps). */
export const EXPECTED_N = 30;
export const HEADLINE_START = "<!-- headline:start -->";
export const HEADLINE_END = "<!-- headline:end -->";

export type Arm = "free-openrouter" | "local-ollama" | "claude-control";
export const ARM_ORDER: Arm[] = ["free-openrouter", "local-ollama", "claude-control"];
const ARM_TITLE: Record<Arm, string> = {
  "free-openrouter": "Free OpenRouter endpoints",
  "local-ollama": "Local Ollama",
  "claude-control": "Claude control (Anthropic API)",
};

export interface Row extends SessionRecord {
  source: string; // file name, e.g. main-free.jsonl
  arm: Arm;
}

export interface FrozenModelInfo {
  id: string;
  role: string;
  provider?: string;
}
export interface Frozen {
  frozenAt?: string;
  models: FrozenModelInfo[];
}

// ---------- small helpers ----------

export function armOf(provider: string): Arm {
  return provider === "ollama" ? "local-ollama" : provider === "anthropic" ? "claude-control" : "free-openrouter";
}

/** Wilson score interval, z = 1.96 (95%). Returns null when n = 0. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const pc = (x: number) => `${Math.round(x * 100)}`;
/** "87% [70-95]" or "-" when n = 0. */
export function fmtRate(k: number, n: number): string {
  const w = wilson(k, n);
  return w ? `${pc(w.p)}% [${pc(w.lo)}-${pc(w.hi)}]` : "-";
}
const fmtPlain = (k: number, n: number) => (n ? `${pc(k / n)}% (${k}/${n})` : "-");

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvEscape).join(",");

export function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Single line, no URLs, truncated. */
export function cleanMessage(s: string | null | undefined, max = 160): string {
  if (!s) return "";
  const t = s
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function replaceMarkedBlock(text: string, start: string, end: string, body: string): string | null {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < 0 || b < a) return null;
  return text.slice(0, a + start.length) + "\n" + body + "\n" + text.slice(b);
}

// ---------- classification ----------

export const isSkipped = (r: SessionRecord) => !!r.skipped || r.firstOutcome === "skipped";
export const isRateLimitedOnly = (r: SessionRecord) =>
  r.firstOutcome === "rate_limited" ||
  (r.requests.length > 0 && r.requests.every((q) => q.rateLimited || q.status === 429));
/** A session counts in rates only if it is not skipped and got at least one non-429 response. */
export const isCounted = (r: SessionRecord) => !isSkipped(r) && !isRateLimitedOnly(r);

export type Failure = "tool_called" | "silent_drop" | "tool_missing_other" | "error_or_refusal" | "unsupported" | "rate_limited" | "skipped";
export function failureClass(r: SessionRecord): Failure {
  if (isSkipped(r)) return "skipped";
  if (isRateLimitedOnly(r)) return "rate_limited";
  switch (r.firstOutcome) {
    case "tool_called":
      return "tool_called";
    case "tool_missing":
      return r.schemaValid ? "silent_drop" : "tool_missing_other";
    case "unsupported":
      return "unsupported";
    default:
      return "error_or_refusal";
  }
}

/** Silent drop whose final JSON does not match the gold answer: the model made the values up. */
export const isInvented = (r: SessionRecord) => failureClass(r) === "silent_drop" && !r.answerCorrect;

// ---------- aggregation ----------

export interface Cell {
  arm: Arm;
  model: string;
  condition: string;
  total: number; // records incl. skipped / rate-limited
  skipped: number;
  rateLimited: number;
  n: number; // counted sessions
  toolCalled: number;
  toolCorrect: number;
  schemaValid: number;
  e2e: number;
  unsupported: number;
  meanCalls: number | null; // non-429 requests per counted session
  medianLatencyMs: number | null;
}

export function buildCells(rows: Row[], pick: (r: Row) => boolean): Cell[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (!pick(r)) continue;
    const k = `${r.arm}\u0000${r.model}\u0000${r.condition}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: Cell[] = [];
  for (const [k, rs] of groups) {
    const [arm, model, condition] = k.split("\u0000") as [Arm, string, string];
    const counted = rs.filter(isCounted);
    const calls = counted.map((r) => r.requests.filter((q) => !q.rateLimited && q.status !== 429).length);
    out.push({
      arm,
      model,
      condition,
      total: rs.length,
      skipped: rs.filter(isSkipped).length,
      rateLimited: rs.filter((r) => !isSkipped(r) && isRateLimitedOnly(r)).length,
      n: counted.length,
      toolCalled: counted.filter((r) => r.firstOutcome === "tool_called").length,
      toolCorrect: counted.filter((r) => r.toolCorrect).length,
      schemaValid: counted.filter((r) => r.schemaValid).length,
      e2e: counted.filter((r) => r.e2eSuccess === true).length,
      unsupported: counted.filter((r) => r.firstOutcome === "unsupported").length,
      meanCalls: calls.length ? calls.reduce((a, b) => a + b, 0) / calls.length : null,
      medianLatencyMs: median(counted.map((r) => r.totalLatencyMs)),
    });
  }
  return out;
}

export function modelOrder(frozen: Frozen, rows: Row[]): string[] {
  const ids = frozen.models.map((m) => m.id);
  for (const r of rows) if (!ids.includes(r.model)) ids.push(r.model);
  return ids;
}

function sortCells(cells: Cell[], order: string[], conds: string[]): Cell[] {
  return [...cells].sort(
    (a, b) =>
      ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm) ||
      order.indexOf(a.model) - order.indexOf(b.model) ||
      conds.indexOf(a.condition) - conds.indexOf(b.condition),
  );
}

const MAIN_CONDS = [...ALL_CONDITIONS] as string[];
const WA_CONDS = [...WORKAROUND_CONDITIONS] as string[];

// ---------- rendering ----------

function cellTir(c: Cell | undefined): string {
  if (!c || c.total === 0) return "-";
  if (c.n === 0) return c.skipped === c.total ? "skipped" : "no data (429)";
  if (c.unsupported === c.n) return `unsupported (n=${c.n})`;
  return fmtPlain(c.toolCalled, c.n);
}

export function renderHeadline(cells: Cell[], order: string[]): string {
  const find = (arm: Arm, model: string, cond: string) => cells.find((c) => c.arm === arm && c.model === model && c.condition === cond);
  const rows = ["| model | arm | tools-only TIR | tools+schema TIR | +required TIR |", "|---|---|---|---|---|"];
  const models = new Map<string, Arm>();
  for (const c of cells) models.set(`${c.arm}\u0000${c.model}`, c.arm);
  const list = [...models.keys()].map((k) => k.split("\u0000") as [Arm, string]);
  list.sort((a, b) => ARM_ORDER.indexOf(a[0]) - ARM_ORDER.indexOf(b[0]) || order.indexOf(a[1]) - order.indexOf(b[1]));
  for (const [arm, model] of list) {
    rows.push(
      `| ${mdEscape(model)} | ${ARM_TITLE[arm]} | ${["tools-only", "tools+schema", "tools+schema+required"].map((c) => cellTir(find(arm, model, c))).join(" | ")} |`,
    );
  }
  return rows.join("\n");
}

function renderMain(cells: Cell[], order: string[]): string {
  const out: string[] = [];
  for (const arm of ARM_ORDER) {
    const cs = sortCells(cells.filter((c) => c.arm === arm), order, MAIN_CONDS);
    if (!cs.length) continue;
    out.push(`### ${ARM_TITLE[arm]}`, "");
    out.push(
      "| model | condition | n | excluded (skipped / 429-only) | first-turn TIR [95% CI] | e2e success [95% CI] | schema-valid |",
      "|---|---|---|---|---|---|---|",
    );
    for (const c of cs) {
      const so = c.condition === "schema-only";
      out.push(
        `| ${mdEscape(c.model)} | ${c.condition} | ${c.n} | ${c.skipped} / ${c.rateLimited} | ${so ? "-" : fmtRate(c.toolCalled, c.n)} | ${so ? "-" : fmtRate(c.e2e, c.n)} | ${fmtPlain(c.schemaValid, c.n)} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

function firstMessage(rs: Row[]): string {
  const cands = rs.filter((r) => failureClass(r) !== "tool_called" && failureClass(r) !== "skipped" && failureClass(r) !== "silent_drop");
  // prefer non-429 messages
  cands.sort((a, b) => Number(isRateLimitedOnly(a)) - Number(isRateLimitedOnly(b)));
  for (const r of cands) {
    const m = r.rawError ?? [...r.requests].reverse().find((q) => q.errorMessage)?.errorMessage;
    if (m) return cleanMessage(m);
  }
  return "";
}

function renderFailures(rows: Row[], order: string[]): string {
  const out = [
    "| model | condition | n sessions | tool called | silent drop (schema-valid, no tool) | tool_missing other | error / refusal | unsupported | rate-limited / incomplete | skipped | example error |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const main = rows.filter((r) => !isWorkaround(r.condition) && !r.source.startsWith("probe-"));
  const groups = new Map<string, Row[]>();
  for (const r of main) {
    if (r.condition !== "tools+schema" && r.condition !== "tools+schema+required") continue;
    const k = `${r.arm}\u0000${r.model}\u0000${r.condition}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [aa, am, ac] = a.split("\u0000") as [Arm, string, string];
    const [ba, bm, bc] = b.split("\u0000") as [Arm, string, string];
    return ARM_ORDER.indexOf(aa) - ARM_ORDER.indexOf(ba) || order.indexOf(am) - order.indexOf(bm) || MAIN_CONDS.indexOf(ac) - MAIN_CONDS.indexOf(bc);
  });
  for (const k of keys) {
    const rs = groups.get(k)!;
    const [, model, cond] = k.split("\u0000") as [Arm, string, string];
    const c = (f: Failure) => rs.filter((r) => failureClass(r) === f).length;
    out.push(
      `| ${mdEscape(model)} | ${cond} | ${rs.length} | ${c("tool_called")} | ${c("silent_drop")} | ${c("tool_missing_other")} | ${c("error_or_refusal")} | ${c("unsupported")} | ${c("rate_limited")} | ${c("skipped")} | ${mdEscape(firstMessage(rs))} |`,
    );
  }
  return out.join("\n");
}

function renderInvented(rows: Row[], order: string[]): string {
  const main = rows.filter((r) => !isWorkaround(r.condition) && !r.source.startsWith("probe-") && (r.condition === "tools+schema" || r.condition === "tools+schema+required"));
  const models = [...new Set(main.map((r) => `${r.arm}\u0000${r.model}`))].sort((a, b) => {
    const [aa, am] = a.split("\u0000") as [Arm, string];
    const [ba, bm] = b.split("\u0000") as [Arm, string];
    return ARM_ORDER.indexOf(aa) - ARM_ORDER.indexOf(ba) || order.indexOf(am) - order.indexOf(bm);
  });
  const out = [
    "A silent drop is *invented* when the final JSON is schema-valid but its values do not match the gold answer (the tool was never called, so the values were made up).",
    "",
    "| model | silent drops | invented values | share | example (condition, task, final JSON) |",
    "|---|---|---|---|---|",
  ];
  for (const mk of models) {
    const [, model] = mk.split("\u0000") as [Arm, string];
    const rs = main.filter((r) => `${r.arm}\u0000${r.model}` === mk);
    const silent = rs.filter((r) => failureClass(r) === "silent_drop");
    const inv = rs.filter(isInvented);
    if (!silent.length) continue;
    const ex = inv.find((r) => r.condition === "tools+schema") ?? inv[0];
    let exText = "";
    if (ex) {
      let body = ex.finalContent;
      try {
        body = JSON.stringify(JSON.parse(ex.finalContent));
      } catch {
        /* keep raw */
      }
      exText = `${ex.condition}, ${ex.taskId}: \`${cleanMessage(body, 160).replace(/`/g, "'")}\``;
    }
    out.push(`| ${mdEscape(model)} | ${silent.length} | ${inv.length} | ${fmtPlain(inv.length, silent.length)} | ${mdEscape(exText)} |`);
  }
  return out.join("\n");
}

function renderWorkarounds(waCells: Cell[], mainCells: Cell[], order: string[]): string {
  if (!waCells.length) return "_No workaround runs found yet._";
  const out = [
    "| model | strategy | n | e2e success [95% CI] | mean calls/session (excl. 429 retries) | median latency ms | baseline tools+schema e2e [95% CI] |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of sortCells(waCells, order, WA_CONDS)) {
    const base = mainCells.find((m) => m.model === c.model && m.condition === "tools+schema");
    out.push(
      `| ${mdEscape(c.model)} | ${c.condition} | ${c.n} | ${fmtRate(c.e2e, c.n)} | ${c.meanCalls === null ? "-" : c.meanCalls.toFixed(2)} | ${c.medianLatencyMs === null ? "-" : Math.round(c.medianLatencyMs)} | ${base ? `${fmtRate(base.e2e, base.n)} (n=${base.n})` : "-"} |`,
    );
  }
  return out.join("\n");
}

export interface FileInfo {
  file: string;
  records: number;
  min: string | null;
  max: string | null;
}

export function fileInfo(file: string, recs: SessionRecord[]): FileInfo {
  const ts = recs.map((r) => r.startedAt).filter(Boolean).sort();
  return { file, records: recs.length, min: ts[0] ?? null, max: ts.at(-1) ?? null };
}

export interface Inputs {
  files: Map<string, SessionRecord[]>;
  frozen: Frozen;
  quota: Record<string, number> | null;
}

export function toRows(files: Map<string, SessionRecord[]>): Row[] {
  const rows: Row[] = [];
  for (const [file, recs] of files) for (const r of recs) rows.push({ ...r, source: file, arm: armOf(r.provider) });
  return rows;
}

const isSmoke = (f: string) => f.startsWith("smoke-");

function renderOps(files: Map<string, SessionRecord[]>, quota: Record<string, number> | null): string {
  const out: string[] = [];
  let reqOr = 0;
  let rl = 0;
  const spend: string[] = [];
  let spendTotal = 0;
  for (const [f, recs] of files) {
    if (isSmoke(f)) continue;
    const cost = recs.reduce((s, r) => s + (r.totalCostUsd || 0), 0);
    spendTotal += cost;
    if (cost > 0) spend.push(`${f}: $${cost.toFixed(4)}`);
    for (const r of recs) {
      if (r.provider !== "openrouter") continue;
      reqOr += r.requests.length;
      rl += r.requests.filter((q) => q.rateLimited || q.status === 429).length;
    }
  }
  out.push(`- OpenRouter requests (all non-smoke files, after resume-dedupe): **${reqOr}**, of which **${rl}** were HTTP 429 / body-429.`);
  out.push(`- Total paid spend (sum of totalCostUsd, non-smoke files): **$${spendTotal.toFixed(4)}**${spend.length ? ` (${spend.join("; ")})` : ""}.`);
  if (quota && Object.keys(quota).length) {
    out.push(`- Free-quota requests by day (\`bench/quota.json\`): ${Object.entries(quota).sort().map(([d, n]) => `${d}: ${n}`).join(", ")}.`);
  } else {
    out.push("- Free-quota file `bench/quota.json` not present.");
  }
  return out.join("\n");
}

function renderOddities(rows: Row[], files: Map<string, SessionRecord[]>, frozen: Frozen, order: string[]): string {
  const out: string[] = [];
  const main = rows.filter((r) => !isWorkaround(r.condition) && !r.source.startsWith("probe-") && !isSmoke(r.source));

  // 1. all rate-limited / never answered
  const byModel = new Map<string, Row[]>();
  for (const r of main) (byModel.get(r.model) ?? byModel.set(r.model, []).get(r.model)!).push(r);
  const dead: string[] = [];
  const partial: string[] = [];
  for (const m of order) {
    const rs = byModel.get(m);
    if (!rs) continue;
    const counted = rs.filter((r) => isCounted(r) && r.condition !== "schema-only");
    const tp = rs.filter((r) => r.condition === "tools+schema");
    if (!counted.length) dead.push(m);
    else if (!tp.some(isCounted)) partial.push(m);
  }
  out.push(`- Models whose sessions were all rate-limited or skipped (no counted sessions outside schema-only): ${dead.length ? dead.map((m) => `\`${m}\``).join(", ") : "none"}.`);
  out.push(`- Models with counted sessions but none under tools+schema: ${partial.length ? partial.map((m) => `\`${m}\``).join(", ") : "none"}.`);

  // 2. finish_reason=length
  const len: string[] = [];
  const lenGroups = new Map<string, number>();
  for (const r of rows) {
    if (isSmoke(r.source)) continue;
    if (r.requests.some((q) => q.finishReason === "length")) {
      const k = `${r.model} / ${r.condition}`;
      lenGroups.set(k, (lenGroups.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of [...lenGroups].sort()) len.push(`${k}: ${n}`);
  out.push(`- Sessions with at least one \`finish_reason=length\`: ${len.length ? len.join("; ") : "none"}.`);

  // 3. gaps
  const gaps: string[] = [];
  const armFiles = new Set(main.map((r) => r.arm));
  for (const m of frozen.models) {
    const arm = armOf(m.provider ?? "openrouter");
    if (!armFiles.has(arm)) continue;
    for (const cond of MAIN_CONDS) {
      const rs = main.filter((r) => r.model === m.id && r.condition === cond);
      const counted = rs.filter(isCounted).length;
      if (counted >= EXPECTED_N) continue;
      const skipped = rs.filter(isSkipped).length;
      const rate = rs.filter((r) => !isSkipped(r) && isRateLimitedOnly(r)).length;
      if (!rs.length && !rows.some((r) => r.model === m.id)) continue; // model never ran in any file
      gaps.push(`${m.id} / ${cond}: n=${counted} of ${EXPECTED_N} (skipped ${skipped}, 429-only ${rate}, no record ${Math.max(0, EXPECTED_N - rs.length)})`);
    }
  }
  out.push(`- Cells below n=${EXPECTED_N} (circuit-breaker or unsupported-cell gaps):`);
  if (gaps.length) for (const g of gaps) out.push(`  - ${g}`);
  else out.push("  - none");

  // probe
  const probe = rows.filter((r) => r.source.startsWith("probe-"));
  if (probe.length) {
    const groups = new Map<string, Row[]>();
    for (const r of probe) (groups.get(`${r.model}\u0000${r.condition}`) ?? groups.set(`${r.model}\u0000${r.condition}`, []).get(`${r.model}\u0000${r.condition}`)!).push(r);
    out.push("- Probe without `provider.require_parameters` (separate from the main table):");
    for (const [k, rs] of groups) {
      const [model, cond] = k.split("\u0000");
      const c = (f: Failure) => rs.filter((r) => failureClass(r) === f).length;
      const msg = firstMessage(rs);
      out.push(
        `  - ${model} / ${cond}: ${rs.length} sessions; tool called ${c("tool_called")}, silent drop ${c("silent_drop")}, other tool_missing ${c("tool_missing_other")}, error ${c("error_or_refusal")}, unsupported ${c("unsupported")}, 429-only ${c("rate_limited")}${msg ? `; e.g. "${msg}"` : ""}`,
      );
    }
  }

  // smoke footnote
  const brew = files.get("smoke-local-brew-noxgrammar.jsonl");
  if (brew) {
    const n501 = brew.reduce((s, r) => s + r.requests.filter((q) => q.status === 501).length, 0);
    out.push(`- Footnote: \`smoke-local-brew-noxgrammar.jsonl\` shows the Homebrew Ollama build lacks xgrammar: ${n501} requests returned HTTP 501 for structured output. The main local run used a different build (MLX engine with xgrammar).`);
  }
  return out.join("\n");
}

function renderRunInfo(infos: FileInfo[], frozen: Frozen): string {
  const out = ["| file | sessions (deduped) | first startedAt | last startedAt |", "|---|---|---|---|"];
  for (const i of infos) out.push(`| ${i.file} | ${i.records} | ${i.min ?? "-"} | ${i.max ?? "-"} |`);
  out.push("");
  out.push(`Frozen model list (bench/models.json, frozen ${frozen.frozenAt ?? "unknown"}):`, "");
  out.push("| model | role |", "|---|---|");
  for (const m of frozen.models) out.push(`| ${mdEscape(m.id)} | ${m.role} |`);
  return out.join("\n");
}

export function renderSummary(inp: Inputs, order?: string[]): { summary: string; headline: string; cells: Cell[]; waCells: Cell[]; rows: Row[] } {
  const rows = toRows(inp.files);
  const ord = order ?? modelOrder(inp.frozen, rows);
  const real = rows.filter((r) => !isSmoke(r.source) && !r.source.startsWith("probe-"));
  const cells = buildCells(real, (r) => !isWorkaround(r.condition));
  const waCells = buildCells(real, (r) => isWorkaround(r.condition));
  const headline = renderHeadline(cells, ord);
  const infos = [...inp.files].filter(([f]) => !isSmoke(f)).map(([f, recs]) => fileInfo(f, recs));
  const s: string[] = [
    "# Results summary",
    "",
    "_Generated by `pnpm report`. Do not edit by hand, except the TODO block at the end._",
    "",
    "Rates exclude skipped sessions and sessions that never received a non-429 response (reported in the `excluded` column). Duplicate keys within a file (resume retries) keep the last record. TIR = share of sessions whose first turn contained a tool call. e2e = correct tool, schema-valid JSON, and values matching the tool output.",
    "",
    "## 1. Runs and models",
    "",
    renderRunInfo(infos, inp.frozen),
    "",
    "## 2. Main results",
    "",
    "### Headline",
    "",
    headline,
    "",
    renderMain(cells, ord),
    "## 3. Failure breakdown (tools+schema, tools+schema+required)",
    "",
    renderFailures(rows.filter((r) => !isSmoke(r.source)), ord),
    "",
    "## 4. Invented values",
    "",
    renderInvented(real, ord),
    "",
    "## 5. Workarounds",
    "",
    renderWorkarounds(waCells, cells, ord),
    "",
    "## 6. Ops",
    "",
    renderOps(inp.files, inp.quota),
    "",
    "## 7. Oddities",
    "",
    renderOddities(rows, inp.files, inp.frozen, ord),
    "",
    "### Notes",
    "",
    "<!-- TODO(human): hand-written notes go here. This block is a placeholder; replace it with your own observations. -->",
    "",
  ];
  return { summary: s.join("\n"), headline, cells, waCells, rows };
}

// ---------- CSV ----------

export function sessionsCsv(rows: Row[]): string {
  const head = ["model", "arm", "condition", "taskId", "rep", "startedAt", "firstOutcome", "toolCalled", "toolCorrect", "schemaValid", "answerCorrect", "e2eSuccess", "requests", "rateLimitedAttempts", "totalLatencyMs", "totalCostUsd", "lastStatus", "lastFinishReason", "skipped", "source"];
  const lines = [csvLine(head)];
  for (const r of rows) {
    const last = r.requests.at(-1);
    lines.push(
      csvLine([r.model, r.arm, r.condition, r.taskId, r.rep, r.startedAt, r.firstOutcome, r.toolCalled, r.toolCorrect, r.schemaValid, r.answerCorrect, r.e2eSuccess, r.requests.length, r.rateLimitedAttempts, r.totalLatencyMs, r.totalCostUsd, last?.status ?? "", last?.finishReason ?? "", r.skipped ?? "", r.source]),
    );
  }
  return lines.join("\n") + "\n";
}

export function cellsCsv(cells: Cell[], waCells: Cell[]): string {
  const head = ["table", "arm", "model", "condition", "n", "skipped", "rateLimitedOnly", "toolCalled", "tir", "tirLo", "tirHi", "e2e", "e2eRate", "e2eLo", "e2eHi", "schemaValid", "schemaValidRate", "meanCalls", "medianLatencyMs"];
  const lines = [csvLine(head)];
  const add = (table: string, c: Cell) => {
    const t = wilson(c.toolCalled, c.n);
    const e = wilson(c.e2e, c.n);
    const so = c.condition === "schema-only";
    const f = (x: number | undefined) => (x === undefined ? "" : x.toFixed(4));
    lines.push(
      csvLine([table, c.arm, c.model, c.condition, c.n, c.skipped, c.rateLimited, so ? "" : c.toolCalled, so ? "" : f(t?.p), so ? "" : f(t?.lo), so ? "" : f(t?.hi), so ? "" : c.e2e, so ? "" : f(e?.p), so ? "" : f(e?.lo), so ? "" : f(e?.hi), c.schemaValid, c.n ? f(c.schemaValid / c.n) : "", c.meanCalls === null ? "" : c.meanCalls.toFixed(3), c.medianLatencyMs === null ? "" : Math.round(c.medianLatencyMs)]),
    );
  };
  for (const c of cells) add("main", c);
  for (const c of waCells) add("workaround", c);
  return lines.join("\n") + "\n";
}

// ---------- CLI ----------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function loadInputs(root: string): Inputs {
  const dir = join(root, "bench", "runs");
  const files = new Map<string, SessionRecord[]>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        files.set(f, loadRecords(readFileSync(join(dir, f), "utf8")));
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  const frozen = readJson<Frozen>(join(root, "bench", "models.json")) ?? { models: [] };
  const quota = readJson<Record<string, number>>(join(root, "bench", "quota.json"));
  return { files, frozen, quota };
}

export function main(root = process.cwd()): void {
  const inp = loadInputs(root);
  const { summary, headline, cells, waCells, rows } = renderSummary(inp);
  const out = join(root, "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.md"), summary);
  writeFileSync(join(out, "sessions.csv"), sessionsCsv(rows.filter((r) => !isSmoke(r.source))));
  writeFileSync(join(out, "cells.csv"), cellsCsv(cells, waCells));
  const readme = join(root, "README.md");
  if (existsSync(readme)) {
    const next = replaceMarkedBlock(readFileSync(readme, "utf8"), HEADLINE_START, HEADLINE_END, headline);
    if (next === null) console.warn("README.md has no headline markers; left unchanged");
    else writeFileSync(readme, next);
  }
  console.log(`wrote results/summary.md, results/sessions.csv (${rows.filter((r) => !isSmoke(r.source)).length} rows), results/cells.csv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
