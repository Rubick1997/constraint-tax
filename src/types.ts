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
}

export interface SessionRecord {
  key: string;
  model: string;
  condition: Condition;
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
  totalLatencyMs: number;
  totalCostUsd: number;
  finalContent: string;
  rawError: string | null;
}

export const sessionKey = (model: string, condition: string, taskId: string, rep: number) =>
  `${model}|${condition}|${taskId}|${rep}`;
