import type { ChatResult, FirstOutcome, SessionRecord } from "./types.js";

export function extractErrorMessage(r: ChatResult): string | null {
  if (r.status === 0) return r.errorMessage ?? "network error";
  const e = r.json?.error;
  if (e) {
    const msg = typeof e === "string" ? e : (e.message ?? JSON.stringify(e));
    const raw = e?.metadata?.raw;
    return raw ? `${msg} | ${typeof raw === "string" ? raw : JSON.stringify(raw)}`.slice(0, 1000) : String(msg).slice(0, 1000);
  }
  if (!r.ok) return r.rawText.slice(0, 1000) || `HTTP ${r.status}`;
  return null;
}

const UNSUPPORTED_RE =
  /no endpoints? (found|available)|can(not|'t) handle the requested|requested parameters|does(n't| not) support|not supported|unsupported (parameter|feature)|require_parameters/i;

export interface Classification {
  outcome: Exclude<FirstOutcome, "skipped">;
  toolCallInText: boolean;
  message: string | null;
}

export function detectToolCallInText(content: unknown, toolNames: string[]): boolean {
  if (typeof content !== "string" || !content) return false;
  if (/<tool_call>|<\|tool_call|"tool_calls"/.test(content)) return true;
  return toolNames.some((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\{[^]*"name"\\s*:\\s*"${esc}"`).test(content);
  });
}

export function classifyFirst(r: ChatResult, toolNames: string[]): Classification {
  const message = extractErrorMessage(r);
  const done = (outcome: Classification["outcome"], toolCallInText = false): Classification => ({
    outcome,
    toolCallInText,
    message,
  });

  if (r.status === 429) return done("rate_limited");
  if (r.status === 0 || !r.ok) {
    if ((r.status === 404 || r.status === 400) && UNSUPPORTED_RE.test(message ?? "")) return done("unsupported");
    return done("error_or_refusal");
  }
  // HTTP 200 from here on
  if (r.json?.error) {
    const code = r.json.error.code;
    return done(code === 429 || code === "429" ? "rate_limited" : "error_or_refusal");
  }
  const choice = r.json?.choices?.[0];
  if (!choice) return done("error_or_refusal");
  const fr = choice.finish_reason;
  if (fr === "error" || fr === "content_filter") return done("error_or_refusal");
  const msg = choice.message ?? {};
  if (typeof msg.refusal === "string" && msg.refusal.length > 0) return done("error_or_refusal");
  const inText = detectToolCallInText(msg.content, toolNames);
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length >= 1) return done("tool_called", inText);
  return done("tool_missing", inText);
}

/** A record is transient (worth retrying) if any request hit 429, 5xx or a network failure. */
export function isTransient(record: Pick<SessionRecord, "requests" | "skipped">): boolean {
  if (record.skipped) return false;
  return record.requests.some((q) => q.status === 429 || q.status === 0 || q.status >= 500);
}
