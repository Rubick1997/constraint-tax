export type Provider = "openrouter" | "anthropic" | "ollama";

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface Task {
  id: string;
  domain: string;
  system: string;
  user: string;
  tools: ToolDef[];
  impl: Record<string, (args: any) => unknown>;
  expectedTool: string;
  expectedArgs: Record<string, string | number>;
  schema: { name: string; schema: object };
  checkAnswer: (answer: any) => boolean;
  /** Builds a correct final answer from the expected tool's output (used by tests). */
  goldAnswer: (toolOutput: any) => any;
}

export type Condition = "tools-only" | "schema-only" | "tools+schema" | "tools+schema+required";
export const ALL_CONDITIONS: Condition[] = [
  "tools-only",
  "schema-only",
  "tools+schema",
  "tools+schema+required",
];

/** Workaround strategies run through packages/tool-schema-safe (never part of "all"). */
export type WorkaroundCondition = "wa-two-phase" | "wa-answer-as-tool";
export const WORKAROUND_CONDITIONS: WorkaroundCondition[] = ["wa-two-phase", "wa-answer-as-tool"];
export type AnyCondition = Condition | WorkaroundCondition;
export const isWorkaround = (c: string): c is WorkaroundCondition => (WORKAROUND_CONDITIONS as string[]).includes(c);

export interface ChatResult {
  ok: boolean;
  status: number; // 0 = network error / timeout
  json: any;
  rawText: string;
  latencyMs: number;
  errorMessage?: string; // network-level message when status 0
  retryAfterSec?: number;
}

export type FirstOutcome =
  | "tool_called"
  | "tool_missing"
  | "error_or_refusal"
  | "unsupported"
  | "rate_limited"
  | "skipped";

export interface RequestRecord {
  status: number;
  latencyMs: number;
  finishReason: string | null;
  toolCallNames: string[];
  usage: any;
  cost: number | null;
  errorMessage: string | null;
  providerName: string | null;
  retryAfterSec: number | null;
  /** Provider-native stop reason (Anthropic: tool_use/end_turn/...); null for OpenAI-shaped providers. */
  rawStopReason: string | null;
  /** 1-based attempt number for this logical request (1 = first try). */
  attempt: number;
  /** Index in `requests` of the 429 attempt this one retries, or null. */
  retryOf: number | null;
  /** True for HTTP 429 or a 200 body whose error.code is 429. */
  rateLimited: boolean;
}

export interface SessionRecord {
  key: string;
  model: string;
  provider: Provider;
  /** Whether provider.require_parameters was actually sent (always false for non-openrouter). */
  requireParameters: boolean;
  condition: AnyCondition;
  taskId: string;
  rep: number;
  startedAt: string;
  skipped?: "unsupported-cell";
  requests: RequestRecord[];
  firstOutcome: FirstOutcome;
  toolCalled: boolean;
  toolCorrect: boolean;
  toolCallInText: boolean;
  finalJsonParsed: boolean;
  schemaValid: boolean;
  answerCorrect: boolean;
  e2eSuccess: boolean | null;
  /** Number of HTTP attempts (across all turns) that were rate limited (429). */
  rateLimitedAttempts: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  finalContent: string;
  rawError: string | null;
}

export const sessionKey = (model: string, condition: string, taskId: string, rep: number) =>
  `${model}|${condition}|${taskId}|${rep}`;
