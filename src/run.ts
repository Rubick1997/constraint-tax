import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "./client.js";
import { isTransient } from "./classify.js";
import { runSession, type Pricing } from "./session.js";
import { TASKS } from "./tasks/index.js";
import { ALL_CONDITIONS, sessionKey, type ChatResult, type Condition, type SessionRecord, type Task } from "./types.js";

export const EST_PROMPT_TOKENS = 1500;
export const EST_COMPLETION_TOKENS = 400;
export const BREAKER_LIMIT = 3;
export const UNSUPPORTED_CELL_LIMIT = 2;

export interface RunOptions {
  models: string; // "all-free" | "controls" | comma list of ids
  conditions: Condition[];
  tasks: string[]; // ids or ["all"]
  reps: number;
  out: string;
  freeLimit: number;
  maxUsd?: number;
  yes: boolean;
  dryRun: boolean;
  modelsFile: string;
  quotaFile: string;
  intervalMs: number;
}

export interface RunDeps {
  client: Client;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (s: string) => void;
  tasks?: Task[];
}

export interface RunResult {
  exitCode: number;
  written: number;
  stopped: Record<string, string>;
  stopReason?: string;
  spentUsd: number;
}

class StopRun extends Error {}

interface FrozenModel {
  id: string;
  role: string;
  pricing?: { prompt?: string; completion?: string } | null;
}

function priceOf(m: FrozenModel): Pricing {
  return { prompt: Number(m.pricing?.prompt ?? 0) || 0, completion: Number(m.pricing?.completion ?? 0) || 0 };
}
const isFree = (id: string) => id.endsWith(":free");
const estRequests = (c: Condition) => (c === "schema-only" ? 1 : 2);

async function readRecords(file: string): Promise<Map<string, SessionRecord>> {
  const map = new Map<string, SessionRecord>();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SessionRecord;
      map.set(r.key, r);
    } catch {
      /* torn line */
    }
  }
  return map;
}

export async function runBench(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const { log } = deps;
  const frozen: FrozenModel[] = JSON.parse(await readFile(opts.modelsFile, "utf8")).models;
  let selected: FrozenModel[];
  if (opts.models === "all-free") selected = frozen.filter((m) => m.role === "free");
  else if (opts.models === "controls") selected = frozen.filter((m) => m.role !== "free");
  else {
    const ids = opts.models.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = ids.filter((id) => !frozen.some((m) => m.id === id));
    if (missing.length) throw new Error(`Not in frozen bench/models.json: ${missing.join(", ")}`);
    selected = ids.map((id) => frozen.find((m) => m.id === id)!);
  }
  const allTasks = deps.tasks ?? TASKS;
  const tasks = opts.tasks.includes("all") ? allTasks : allTasks.filter((t) => opts.tasks.includes(t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const existing = await readRecords(opts.out);
  const planned: { model: FrozenModel; condition: Condition; task: Task; rep: number; key: string }[] = [];
  for (const model of selected)
    for (const condition of opts.conditions)
      for (const task of tasks)
        for (let rep = 1; rep <= opts.reps; rep++)
          planned.push({ model, condition, task, rep, key: sessionKey(model.id, condition, task.id, rep) });
  const pending = planned.filter((s) => {
    const r = existing.get(s.key);
    return !r || isTransient(r);
  });

  // projections
  let freeReqs = 0;
  let paidReqs = 0;
  let paidUsd = 0;
  for (const s of pending) {
    const n = estRequests(s.condition);
    if (isFree(s.model.id)) freeReqs += n;
    else {
      const p = priceOf(s.model);
      paidReqs += n;
      paidUsd += n * (EST_PROMPT_TOKENS * p.prompt + EST_COMPLETION_TOKENS * p.completion);
    }
  }
  const hasPaid = selected.some((m) => !isFree(m.id));
  log(`Sessions total: ${planned.length} (already done: ${planned.length - pending.length}, pending: ${pending.length})`);
  log(`Projected requests (pending, est. 2 per tool session, 1 for schema-only): free ${freeReqs}, paid ${paidReqs}`);
  log(`Free-quota days at ${opts.freeLimit}/day: ${(freeReqs / opts.freeLimit).toFixed(2)}`);
  if (hasPaid) log(`Paid projection (est. ${EST_PROMPT_TOKENS} prompt + ${EST_COMPLETION_TOKENS} completion tokens/request): $${paidUsd.toFixed(4)}`);

  if (opts.dryRun) return { exitCode: 0, written: 0, stopped: {}, spentUsd: 0 };
  if (hasPaid && !(opts.maxUsd !== undefined && opts.yes)) {
    log("Paid models selected: re-run with BOTH --max-usd <X> and --yes to proceed. Nothing was sent.");
    return { exitCode: 2, written: 0, stopped: {}, spentUsd: 0 };
  }

  try {
    const info = await deps.client.getKeyInfo();
    const pick = Object.fromEntries(Object.entries(info).filter(([k]) => /usage|limit/i.test(k)));
    log(`Key info: ${JSON.stringify(pick)}`);
  } catch (e: any) {
    log(`WARNING: could not read key info: ${e.message}`);
  }

  // quota
  const today = () => new Date(deps.now()).toISOString().slice(0, 10);
  let quota: Record<string, number> = {};
  try {
    quota = JSON.parse(await readFile(opts.quotaFile, "utf8"));
  } catch {
    /* fresh */
  }
  const bumpQuota = async () => {
    quota[today()] = (quota[today()] ?? 0) + 1;
    await mkdir(dirname(opts.quotaFile), { recursive: true });
    await writeFile(opts.quotaFile, JSON.stringify(quota, null, 2) + "\n");
  };

  // global rate limiter + spend guard
  let lastAt = -Infinity;
  let notBefore = 0;
  let spent = 0;
  const wrapChat = (model: FrozenModel) => async (body: any): Promise<ChatResult> => {
    const free = isFree(model.id);
    const p = priceOf(model);
    if (free && (quota[today()] ?? 0) + 1 > opts.freeLimit) throw new StopRun(`free quota limit ${opts.freeLimit} reached for ${today()}`);
    if (!free && opts.maxUsd !== undefined) {
      const est = EST_PROMPT_TOKENS * p.prompt + EST_COMPLETION_TOKENS * p.completion;
      if (spent + est > opts.maxUsd) throw new StopRun(`--max-usd ${opts.maxUsd} would be exceeded (spent $${spent.toFixed(4)})`);
    }
    const wait = Math.max(lastAt + opts.intervalMs, notBefore) - deps.now();
    if (wait > 0) await deps.sleep(wait);
    lastAt = deps.now();
    if (free) await bumpQuota();
    const res = await deps.client.chat(body);
    lastAt = deps.now();
    if (res.status === 429 && res.retryAfterSec) notBefore = deps.now() + Math.min(res.retryAfterSec, 60) * 1000;
    if (!free) {
      const u = res.json?.usage;
      spent += typeof u?.cost === "number" ? u.cost : u ? (u.prompt_tokens ?? 0) * p.prompt + (u.completion_tokens ?? 0) * p.completion : 0;
    }
    return res;
  };

  const append = async (r: SessionRecord) => {
    await mkdir(dirname(opts.out), { recursive: true });
    await appendFile(opts.out, JSON.stringify(r) + "\n");
  };

  const stopped: Record<string, string> = {};
  const consec = new Map<string, number>();
  const unsupportedCount = new Map<string, number>();
  for (const r of existing.values())
    if (r.firstOutcome === "unsupported") {
      const c = `${r.model}|${r.condition}`;
      unsupportedCount.set(c, (unsupportedCount.get(c) ?? 0) + 1);
    }

  let written = 0;
  let stopReason: string | undefined;
  for (const s of pending) {
    const mid = s.model.id;
    if (stopped[mid]) continue;
    const cell = `${mid}|${s.condition}`;
    if ((unsupportedCount.get(cell) ?? 0) >= UNSUPPORTED_CELL_LIMIT) {
      await append({
        key: s.key, model: mid, condition: s.condition, taskId: s.task.id, rep: s.rep,
        startedAt: new Date(deps.now()).toISOString(), skipped: "unsupported-cell", requests: [],
        firstOutcome: "skipped", toolCalled: false, toolCorrect: false, toolCallInText: false,
        finalJsonParsed: false, schemaValid: false, answerCorrect: false,
        e2eSuccess: s.condition === "schema-only" ? null : false,
        rateLimitedAttempts: 0, totalLatencyMs: 0, totalCostUsd: 0, finalContent: "", rawError: null,
      });
      written++;
      continue;
    }
    let rec: SessionRecord;
    try {
      rec = await runSession({ chat: wrapChat(s.model), now: deps.now, sleep: deps.sleep, pricing: priceOf(s.model) }, { ...s, model: mid });
    } catch (e) {
      if (e instanceof StopRun) {
        stopReason = e.message;
        log(`STOP: ${e.message}`);
        break;
      }
      throw e;
    }
    await append(rec);
    written++;

    const bad = rec.firstOutcome === "error_or_refusal" || rec.firstOutcome === "rate_limited" || isTransient(rec);
    if (rec.firstOutcome === "unsupported") unsupportedCount.set(cell, (unsupportedCount.get(cell) ?? 0) + 1);
    else consec.set(mid, bad ? (consec.get(mid) ?? 0) + 1 : 0);
    if ((consec.get(mid) ?? 0) >= BREAKER_LIMIT) {
      const last = rec.requests.at(-1);
      const ra = last?.retryAfterSec ? ` Retry-After ${last.retryAfterSec}s (capped to 60s sleep).` : "";
      stopped[mid] = `circuit breaker: ${BREAKER_LIMIT} consecutive failures; last first-turn outcome ${rec.firstOutcome}, status ${last?.status}, "${(rec.rawError ?? "").slice(0, 200)}".${ra}`;
      log(`BREAKER ${mid}: ${stopped[mid]}`);
    }
  }
  log(`Done. Records written: ${written}. Spent (paid): $${spent.toFixed(4)}.`);
  return { exitCode: 0, written, stopped, stopReason, spentUsd: spent };
}

function cli() {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      conditions: { type: "string", default: "all" },
      tasks: { type: "string", default: "all" },
      reps: { type: "string", default: "2" },
      out: { type: "string" },
      "free-limit": { type: "string", default: "900" },
      "max-usd": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.models) throw new Error("--models <ids|all-free|controls> is required");
  const conditions = values.conditions === "all" ? ALL_CONDITIONS : (values.conditions!.split(",") as Condition[]);
  for (const c of conditions) if (!ALL_CONDITIONS.includes(c)) throw new Error(`unknown condition ${c}`);
  const dry = values["dry-run"]!;
  if (!values.out && !dry) throw new Error("--out bench/runs/<name>.jsonl is required");
  const opts: RunOptions = {
    models: values.models,
    conditions,
    tasks: values.tasks!.split(","),
    reps: Number(values.reps),
    out: values.out ?? "bench/runs/dry-run.jsonl",
    freeLimit: Number(values["free-limit"]),
    maxUsd: values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined,
    yes: values.yes!,
    dryRun: dry,
    modelsFile: "bench/models.json",
    quotaFile: "bench/quota.json",
    intervalMs: 3100,
  };
  return runBench(opts, {
    client: createClient(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log: (s) => console.log(s),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli()
    .then((r) => process.exit(r.exitCode))
    .catch((e) => {
      console.error(String(e.message ?? e));
      process.exit(1);
    });
}
