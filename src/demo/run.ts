import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Client } from "../client.js";
import { createAnthropicClient, createOllamaClient } from "../providers.js";
import { demoKey, parseArms, runArm, usesClaude, type Arm, type DemoRecord } from "./arms.js";
import { projectAll, projectSession } from "./project.js";
import { DEMO_TASKS, type DemoTask } from "./tasks.js";

export const DEFAULT_OUT = "bench/demo/runs/demo.jsonl";
export const BREAKER_LIMIT = 3;

export interface DemoOptions {
  arms: string;
  tasks: string[]; // ids or ["all"]
  reps: number;
  out: string;
  maxUsd?: number;
  yes: boolean;
  dryRun: boolean;
}
export interface DemoDeps {
  claude: Client;
  ollama: Client;
  now: () => number;
  log: (s: string) => void;
  tasks?: DemoTask[];
}
export interface DemoResult {
  exitCode: number;
  written: number;
  spentUsd: number;
  stopReason?: string;
  stopped: Record<string, string>;
}

class CapReached extends Error {}

export async function readDemoRecords(file: string): Promise<Map<string, DemoRecord>> {
  const map = new Map<string, DemoRecord>();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DemoRecord;
      map.set(r.key, r);
    } catch {
      /* torn line */
    }
  }
  return map;
}

export async function runDemo(opts: DemoOptions, deps: DemoDeps): Promise<DemoResult> {
  const { log } = deps;
  const arms = parseArms(opts.arms);
  const allTasks = deps.tasks ?? DEMO_TASKS;
  const tasks = opts.tasks.includes("all") ? allTasks : allTasks.filter((t) => opts.tasks.includes(t.id));
  if (!tasks.length) throw new Error("no tasks selected");
  const existing = await readDemoRecords(opts.out);

  const planned: { arm: Arm; task: DemoTask; rep: number; key: string }[] = [];
  for (let rep = 1; rep <= opts.reps; rep++) for (const task of tasks) for (const arm of arms) planned.push({ arm, task, rep, key: demoKey(arm.name, task.id, rep) });
  const pending = planned.filter((s) => {
    const r = existing.get(s.key);
    return !r || r.transient;
  });

  // Projection for the pending sessions.
  let calls = 0;
  let usd = 0;
  let maxUsd = 0;
  for (const s of pending) {
    const p = projectSession(s.arm, s.task);
    calls += p.claudeCalls;
    usd += p.usd;
    maxUsd += p.maxUsd;
  }
  const hasClaude = arms.some(usesClaude);
  log(`Arms: ${arms.map((a) => a.name).join(", ")}`);
  log(`Sessions total: ${planned.length} (already done: ${planned.length - pending.length}, pending: ${pending.length})`);
  log(`Worker temperature: 0 (local models). Claude: default sampling and thinking.`);
  log(`Projected Claude calls (pending): ${calls}; projected Claude spend: $${usd.toFixed(2)} (up to $${maxUsd.toFixed(2)} if every brain-worker session uses its re-run). Rough estimate, ~3.5 chars/token.`);
  if (!pending.length) log("Nothing to do.");
  if (opts.dryRun) {
    for (const a of arms) log(`  ${a.name.padEnd(34)} Claude calls ${projectAll([a], tasks, 1).claudeCalls} per rep, ~$${projectAll([a], tasks, 1).usd.toFixed(3)} per rep`);
    return { exitCode: 0, written: 0, spentUsd: 0, stopped: {} };
  }
  if (hasClaude && !(opts.maxUsd !== undefined && opts.yes)) {
    log("Claude arms selected: re-run with BOTH --max-usd <X> and --yes to proceed. Nothing was sent.");
    return { exitCode: 2, written: 0, spentUsd: 0, stopped: {} };
  }

  let spent = 0;
  let capHit = false;
  const guard = () => {
    if (opts.maxUsd !== undefined && spent >= opts.maxUsd) {
      capHit = true;
      throw new CapReached(`--max-usd ${opts.maxUsd} reached (spent $${spent.toFixed(4)})`);
    }
  };
  const stopped: Record<string, string> = {};
  const consecutive = new Map<string, number>();
  let written = 0;
  let stopReason: string | undefined;

  for (const s of pending) {
    if (stopped[s.arm.name]) continue;
    if (usesClaude(s.arm)) {
      try {
        guard();
      } catch (e: any) {
        stopReason = e.message;
        break;
      }
    }
    const rec = await runArm(s.arm, s.task, s.rep, { claude: deps.claude, ollama: deps.ollama, now: deps.now, guard, onClaudeCost: (c) => (spent += c) });
    if (capHit) {
      stopReason = `--max-usd ${opts.maxUsd} reached (spent $${spent.toFixed(4)}); the interrupted session was discarded`;
      break;
    }
    await mkdir(dirname(opts.out), { recursive: true });
    await appendFile(opts.out, JSON.stringify(rec) + "\n");
    written++;
    log(`${rec.key} ${rec.correct ? "ok" : `wrong (${rec.fieldScore.toFixed(2)})`} claude $${rec.claudeCostUsd.toFixed(4)} worker ${rec.workerCalls} calls ${Math.round(rec.totalLatencyMs / 1000)}s${rec.error ? ` error: ${rec.error.slice(0, 120)}` : ""}`);
    const bad = rec.error !== null && rec.transient;
    consecutive.set(s.arm.name, bad ? (consecutive.get(s.arm.name) ?? 0) + 1 : 0);
    if ((consecutive.get(s.arm.name) ?? 0) >= BREAKER_LIMIT) {
      stopped[s.arm.name] = `circuit breaker: ${BREAKER_LIMIT} consecutive transient failures, last: ${rec.error?.slice(0, 200)}`;
      log(`BREAKER ${s.arm.name}: ${stopped[s.arm.name]}`);
    }
    if (opts.maxUsd !== undefined && spent >= opts.maxUsd) {
      stopReason = `--max-usd ${opts.maxUsd} reached (spent $${spent.toFixed(4)})`;
      break;
    }
  }
  if (stopReason) log(`STOP: ${stopReason}`);
  log(`Done. Records written: ${written}. Claude spend: $${spent.toFixed(4)}.`);
  return { exitCode: 0, written, spentUsd: spent, stopReason, stopped };
}

function cli() {
  const { values } = parseArgs({
    options: {
      arms: { type: "string", default: "all" },
      tasks: { type: "string", default: "all" },
      reps: { type: "string", default: "2" },
      out: { type: "string", default: DEFAULT_OUT },
      "max-usd": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const opts: DemoOptions = {
    arms: values.arms!,
    tasks: values.tasks!.split(","),
    reps: Number(values.reps),
    out: values.out!,
    maxUsd: values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined,
    yes: values.yes!,
    dryRun: values["dry-run"]!,
  };
  return runDemo(opts, { claude: createAnthropicClient(), ollama: createOllamaClient(), now: Date.now, log: (s) => console.log(s) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli()
    .then((r) => process.exit(r.exitCode))
    .catch((e) => {
      console.error(String(e.message ?? e));
      process.exit(1);
    });
}
