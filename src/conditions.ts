import type { Condition, Provider, Task } from "./types.js";

export type { Condition };

/**
 * Builds the request body for one turn.
 *
 * `tool_choice: "required"` is sent on TURN 1 ONLY for `tools+schema+required`. On later turns
 * it is omitted: once the tool result is in context the model must be free to give the final
 * answer, and "required" would force another tool call forever.
 * No other condition ever sets `tool_choice`.
 */
export function buildRequest(
  model: string,
  task: Task,
  condition: Condition,
  messages: unknown[],
  turn: number,
  opts: { provider?: Provider; requireParameters?: boolean } = {},
) {
  const provider = opts.provider ?? "openrouter";
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.5,
    max_tokens: 4096,
  };
  // OpenRouter-only fields. Ollama rejects/ignores them; the Anthropic adapter drops them anyway.
  if (provider === "openrouter") {
    if (opts.requireParameters !== false) body.provider = { require_parameters: true };
    body.usage = { include: true };
  }
  const hasTools = condition !== "schema-only";
  const hasSchema = condition !== "tools-only";
  if (hasTools) body.tools = task.tools;
  if (hasSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: task.schema.name, strict: true, schema: task.schema.schema },
    };
  }
  if (condition === "tools+schema+required" && turn === 1) body.tool_choice = "required";
  return body;
}
