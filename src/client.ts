import type { ChatResult } from "./types.js";

export type FetchLike = (url: string, init?: any) => Promise<any>;

export interface Client {
  chat(body: unknown): Promise<ChatResult>;
  getKeyInfo(): Promise<Record<string, unknown>>;
}

export interface ClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function createClient(opts: ClientOptions = {}): Client {
  const f: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const getKey = (): string => {
    const k = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!k) throw new Error("OPENROUTER_API_KEY is not set (needed for this call). Export it in your shell; it is never printed.");
    return k;
  };

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<ChatResult> {
    const key = getKey();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await f(baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const rawText: string = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(rawText);
      } catch {
        /* non-JSON body: keep rawText */
      }
      const ra = Number(res.headers?.get?.("retry-after"));
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json,
        rawText,
        latencyMs: Date.now() - t0,
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
      };
    } catch (e: any) {
      const aborted = e?.name === "AbortError" || ctrl.signal.aborted;
      return {
        ok: false,
        status: 0,
        json: null,
        rawText: "",
        latencyMs: Date.now() - t0,
        errorMessage: aborted ? `timeout after ${timeoutMs} ms` : `network error: ${e?.message ?? String(e)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    chat: (body) => request("POST", "/chat/completions", body),
    async getKeyInfo() {
      const r = await request("GET", "/key");
      if (!r.ok) throw new Error(`GET /key failed: status ${r.status} ${r.errorMessage ?? r.rawText.slice(0, 200)}`);
      const { label: _label, ...rest } = (r.json?.data ?? {}) as Record<string, unknown>;
      return rest;
    },
  };
}
