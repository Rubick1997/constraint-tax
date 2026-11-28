# tool-schema-safe

Get **tool calls and schema-valid JSON in the same request flow**, even on chat endpoints that silently drop `tools` when
`response_format: json_schema` is on (the "constraint tax"). Provider-agnostic: you pass in a `chat` function; the
package only speaks OpenAI `chat.completions` JSON. Only runtime dependency: `ajv`.

```ts
import { withToolsAndSchema, type ChatFn } from "tool-schema-safe";

const chat: ChatFn = async (body) => {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status }); // must carry `status`
  return res.json();
};

const r = await withToolsAndSchema(chat, {
  model: "some/model",
  messages: [{ role: "user", content: "Where is order QX-48213?" }],
  tools: [{ type: "function", function: { name: "get_order_status", description: "Look up an order", parameters: {
    type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } } }],
  schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
  executeTool: (name, args) => ({ status: "held_at_customs" }),
  strategy: "auto",
  extraBody: { temperature: 0 },
});
// r.answer, r.validated, r.toolCalls, r.calls, r.latencyMs, r.strategyUsed, r.fellBack
```

## Strategies

| strategy | requests | what it does |
|---|---|---|
| `native` | 1 + tool rounds | tools and strict `response_format` together; final content parsed as JSON (``` fences stripped) |
| `two-phase` | tool rounds + 2 | phase 1: tools, no schema, loop until the model answers without tool calls. Phase 2: one call with `response_format` and **no** tools / `tool_choice`. The phase-1 plain-text reply is kept in the context (dropped if empty or if `maxTurns` ran out mid tool call). |
| `answer-as-tool` | tool rounds + 1 | no `response_format`; a `submit_answer` function whose parameters are your schema ends the run (never passed to `executeTool`). A plain-text reply gets one nudge; after that the text is parsed as JSON as a last resort. |
| `auto` | varies | per-model memory (in process). Unknown model: try `native`. If the first turn returns no tool call although tools were offered (silent drop), or the request throws a 4xx (except 408/429), mark the model broken and rerun with `answer-as-tool` (`fellBack: true`; `calls` includes the failed attempt). A first-turn tool call marks it ok. Known-broken goes straight to `answer-as-tool`. Why not `two-phase`: its second call needs `response_format`, and some endpoints that support tools do not support it (measured: 0/30 on one free endpoint, while `answer-as-tool` got 22/23). |

Caveat for `auto`: a task where the model legitimately needs no tool looks like a silent drop. Use `auto` for
tool-requiring tasks, or call `resetAutoMemory()` / pick a strategy explicitly.

Other notes: `maxTurns` (default 4) limits rounds of tool execution. `extraBody` is merged into every request. Errors from
`chat` are caught and returned in `error` (with `answer: null`). The final answer is validated with ajv (`strict: false`);
`validationErrors` is set when it fails. Some providers (e.g. Anthropic) reject tool-call history in a request with no
`tools`, which `two-phase` phase 2 relies on; use `answer-as-tool` there.
