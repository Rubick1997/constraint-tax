# constraint-tax

When you ask a chat endpoint for tool calls and strict JSON-schema output (`response_format` with `json_schema`, `strict: true`) in the same request, does it still call the tools? This repo measures that on free hosted endpoints (OpenRouter), local models (Ollama) and one closed control (Claude Haiku 5.5 through the Anthropic API). It reproduces the "constraint tax" reported for open-weight models in [arXiv:2606.25605](https://arxiv.org/abs/2606.25605), and extends it with hosted endpoints, four distinct outcomes instead of one bit, real tool execution, and confidence intervals.

## Headline result

First-turn tool invocation rate (TIR): the share of sessions whose first model turn contains a tool call. Each cell shows `rate (calls/sessions)`; small denominators mean the run was cut short (rate limits, circuit breaker) or the endpoint rejected the request.

<!-- headline:start -->
| model | arm | tools-only TIR | tools+schema TIR | +required TIR |
|---|---|---|---|---|
| inclusionai/ling-3.2-flash:free | Free OpenRouter endpoints | 100% (2/2) | - | - |
| baidu/ernie-5.5-flash-preview:free | Free OpenRouter endpoints | 100% (30/30) | 0% (0/30) | 0% (0/4) |
| liquid/lfm-3-1.7b:free | Free OpenRouter endpoints | 100% (30/30) | 0% (0/30) | 0% (0/4) |
| particle-ai/particle-1:free | Free OpenRouter endpoints | 100% (30/30) | 0% (0/30) | 0% (0/3) |
| recursive/flint-v1.0:free | Free OpenRouter endpoints | 100% (30/30) | unsupported (n=2) | unsupported (n=2) |
| nvidia/nemotron-3.5-super-vl:free | Free OpenRouter endpoints | 100% (30/30) | 0% (0/30) | 100% (30/30) |
| google/gemma-4-31b-it:free | Free OpenRouter endpoints | no data (429) | - | - |
| google/gemma-4-26b-a4b-it:free | Free OpenRouter endpoints | no data (429) | - | - |
| gemma4:26b-a4b | Local Ollama | 100% (30/30) | 0% (0/30) | 0% (0/30) |
| lfm3:1.7b | Local Ollama | 100% (30/30) | 0% (0/30) | 0% (0/30) |
| qwen3.6:35b-a3b | Local Ollama | 100% (30/30) | 0% (0/30) | 0% (0/30) |
| claude-haiku-5-5 | Claude control (Anthropic API) | 100% (30/30) | 100% (30/30) | 100% (30/30) |
<!-- headline:end -->

Full tables, confidence intervals, failure breakdown and per-session data: [`results/summary.md`](results/summary.md), [`results/cells.csv`](results/cells.csv), [`results/sessions.csv`](results/sessions.csv).

## What we found

- Silent drop is the common failure. On every free hosted endpoint we could test with `tools` + `json_schema`, and on every local model, the model skips the tool and returns schema-valid JSON with no error.
- The silently returned JSON is made up: the values never match the tool's data (see "Invented values" in the summary).
- `tool_choice: "required"` does not reliably help. One hosted endpoint honours it; others reject the request with a 400, and the local models ignore it and still drop the tool.
- The closed control (Claude Haiku 5.5, Anthropic API) calls the tool on every first turn under both constraints.
- Some endpoints could not be tested: one rejects the parameter combination at routing time, and some were blocked by upstream rate limits. TODO: confirm the final list of untestable endpoints once the main run is closed.
- Both workarounds (`two-phase`, `answer-as-tool`) restore end-to-end success in the sessions run so far. TODO: re-check against the final workaround run and add its n.

## The fix

[`packages/tool-schema-safe`](packages/tool-schema-safe) wraps a chat function and picks a strategy that keeps tools and schema compatible: `two-phase` (tools first, schema in a second tool-less call), `answer-as-tool` (the schema becomes the parameters of a `submit_answer` function), or `auto` (try native, fall back to `answer-as-tool` after a silent drop or a 4xx).

```ts
import { withToolsAndSchema, type ChatFn } from "tool-schema-safe";

const chat: ChatFn = async (body) => {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
  return res.json();
};

const r = await withToolsAndSchema(chat, {
  model: "some/model",
  messages: [{ role: "user", content: "Where is order QX-48213?" }],
  tools: [/* your tool definitions */],
  schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
  executeTool: (name, args) => ({ status: "held_at_customs" }),
  strategy: "auto",
});
// r.answer, r.validated, r.toolCalls, r.strategyUsed, r.fellBack
```

See the [package README](packages/tool-schema-safe/README.md) for all options.

## Reproduce

```sh
pnpm install

export OPENROUTER_API_KEY=...    # free OpenRouter endpoints
export ANTHROPIC_API_KEY=...     # Claude control
# Local models: run Ollama with a build that supports structured output (xgrammar).
# OPENAI_BASE_URL overrides the OpenAI-compatible base URL (default: OpenRouter);
# OLLAMA_BASE_URL overrides the Ollama endpoint.

pnpm models:freeze                                   # snapshot the free model list into bench/models.json
pnpm bench --models all-free --dry-run               # print the plan and request budget, send nothing
pnpm bench --models all-free --out bench/runs/main-free.jsonl
pnpm bench --models anthropic --out bench/runs/main-anthropic.jsonl --max-usd 1
pnpm bench --models local --out bench/runs/main-local.jsonl
pnpm bench --models <id> --conditions workarounds --out bench/runs/workarounds-<name>.jsonl
pnpm report                                          # writes results/ and refreshes the table above
pnpm test && pnpm typecheck
```

Runs are resumable: an existing output file is read and finished sessions are skipped. Design notes and the paper's setup are in [`bench/README.md`](bench/README.md) and [`bench/PAPER.md`](bench/PAPER.md).

## Data policy

All prompts, tools and tool outputs are synthetic (15 fake lookup tasks in `src/tasks`, dumped to `bench/tasks.json`); no real user data is sent anywhere. Free endpoints may log prompts and completions, so do not point this benchmark at private data.

## Credit

The experimental design follows Li, Zhang and Lv, "Constraint Tax in Open-Weight LLMs: An Empirical Study of Tool Calling Suppression Under Structured Output Constraints", [arXiv:2606.25605](https://arxiv.org/abs/2606.25605). Their local SGLang/vLLM setup is not reproduced here; we test hosted and Ollama endpoints instead.

## License

MIT, see [LICENSE](LICENSE).
