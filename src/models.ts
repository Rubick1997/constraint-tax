import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { FetchLike } from "./client.js";

export type Role = "free" | "closed-control" | "local";

export const PINNED: { id: string; role: Role }[] = [
  ...[
    "inclusionai/ling-3.2-flash:free",
    "baidu/ernie-5.5-flash-preview:free",
    "liquid/lfm-3-1.7b:free",
    "particle-ai/particle-1:free",
    "recursive/flint-v1.0:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
  ].map((id) => ({ id, role: "free" as const })),
  // Paid controls now run on Anthropic (provider "anthropic"), not OpenRouter; see bench/models.json.
];

const SUBSET = ["tools", "tool_choice", "response_format", "structured_outputs"];
const subset = (p: unknown): string[] => (Array.isArray(p) ? p.filter((x) => SUBSET.includes(x)) : []);
const BASE = "https://openrouter.ai/api/v1";

async function getJson(f: FetchLike, url: string): Promise<any> {
  const res = await f(url, { headers: { Accept: "application/json" } });
  if (res.status < 200 || res.status >= 300) throw new Error(`GET ${url} -> ${res.status}`);
  return JSON.parse(await res.text());
}

/**
 * `existing` = the models currently in bench/models.json. Entries whose provider is not
 * "openrouter" (anthropic, ollama) are hand-maintained and copied through unchanged.
 */
export async function freeze(f: FetchLike, now: Date = new Date(), existing: any[] = []) {
  const all: any[] = (await getJson(f, `${BASE}/models`)).data ?? [];
  const byId = new Map(all.map((m) => [m.id, m]));
  const missing = PINNED.filter((p) => !byId.has(p.id)).map((p) => p.id);
  if (missing.length) throw new Error(`Pinned models missing from /models: ${missing.join(", ")}`);

  const models: any[] = [];
  for (const p of PINNED) {
    const m = byId.get(p.id);
    let endpoints: any[] = [];
    let epError: string | undefined;
    try {
      const ep = await getJson(f, `${BASE}/models/${p.id}/endpoints`);
      endpoints = (ep.data?.endpoints ?? []).map((e: any) => ({
        provider_name: e.provider_name ?? null,
        quantization: e.quantization ?? null,
        status: e.status ?? null,
        supported_parameters: subset(e.supported_parameters),
        pricing: e.pricing ?? null,
      }));
    } catch (e: any) {
      epError = e.message;
    }
    const sp = subset(m.supported_parameters);
    const notes: string[] = [];
    if (!sp.includes("tool_choice")) notes.push("no tool_choice advertised");
    if (!sp.includes("structured_outputs")) notes.push("no structured_outputs advertised (response_format only)");
    if (endpoints.some((e) => e.status !== 0)) notes.push("endpoint status != 0");
    if (!m.hugging_face_id) notes.push("no hugging_face_id: open weights unconfirmed");
    if (epError) notes.push(`endpoints fetch failed: ${epError}`);
    models.push({
      id: p.id,
      provider: "openrouter",
      role: p.role,
      maker: p.id.split("/")[0],
      huggingFaceId: m.hugging_face_id || null,
      contextLength: m.context_length ?? null,
      supportedParameters: sp,
      pricing: m.pricing ?? null,
      endpoints,
      notes,
    });
  }

  for (const m of existing) if (m?.provider && m.provider !== "openrouter") models.push(m);

  const candidates = all
    .filter((m) => typeof m.id === "string" && m.id.endsWith(":free") && m.id !== "openrouter/free")
    .map((m) => {
      const sp: string[] = m.supported_parameters ?? [];
      return {
        id: m.id,
        name: m.name ?? null,
        contextLength: m.context_length ?? null,
        tools: sp.includes("tools"),
        tool_choice: sp.includes("tool_choice"),
        response_format: sp.includes("response_format"),
        structured_outputs: sp.includes("structured_outputs"),
        pinned: PINNED.some((p) => p.id === m.id),
      };
    });

  return {
    frozen: { frozenAt: now.toISOString(), source: `${BASE}/models`, models },
    candidates: { frozenAt: now.toISOString(), candidates },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let existing: any[] = [];
  try {
    existing = JSON.parse(readFileSync("bench/models.json", "utf8")).models ?? [];
  } catch {
    /* first freeze */
  }
  freeze((u, i) => fetch(u, i), new Date(), existing)
    .then(({ frozen, candidates }) => {
      mkdirSync("bench", { recursive: true });
      writeFileSync("bench/models.json", JSON.stringify(frozen, null, 2) + "\n");
      writeFileSync("bench/candidates.json", JSON.stringify(candidates, null, 2) + "\n");
      console.log(`froze ${frozen.models.length} models, ${candidates.candidates.length} free candidates`);
      for (const m of frozen.models) console.log(`- ${m.id} [${m.role}] ${m.notes.length ? m.notes.join("; ") : "ok"}`);
    })
    .catch((e) => {
      console.error(String(e.message ?? e));
      process.exit(1);
    });
}
