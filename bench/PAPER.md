# The paper we reproduce

**Li, Zhang, Lv. "Constraint Tax in Open-Weight LLMs: An Empirical Study of Tool Calling Suppression Under Structured Output Constraints." arXiv:2606.25605v1, 24 Jun 2026.** https://arxiv.org/abs/2606.25605v1

(HANDOFF.md cited arXiv 2604.25359. That ID is the *Structured Output Benchmark* (SOB), an extraction-accuracy benchmark with no tool calling. Wrong citation, corrected here.)

Read 24 Nov 2026. Appendices A.6, A.7 and parts of A.2 were read through a summary, so the server flags and versions below should be checked against the PDF before we quote them.

## Conditions

| Paper | Tools | `response_format` | Ours |
|---|---|---|---|
| T1 baseline | on | off | `tools-only` |
| T3 schema-only control | off | on | `schema-only` |
| T2 joint constraint | on | on | `tools+schema` |
| Table 9, `tool_choice="required"` (T2 only) | on | on | `tools+schema+required` |

- Schema goes in `response_format={"type":"json_schema","json_schema":{...,"strict":true}}`. We use the same.
- Only `tools` and `response_format` change between conditions. Prompts, tool definitions and parsing stay identical. We do the same.
- The paper doesn't say what `tool_choice` T1/T2/T3 used (presumably the default, `auto`). We leave it unset outside the `required` condition.
- Table 9 also tests "required" stated in the user prompt or the system prompt. They gave the same 0%, so we skip those.

## Setup

- 7 models (8 rows: Qwen3.6-35B-A3B ran on both SGLang 0.5.9 and vLLM 0.22.0). Guided decoding was xgrammar on both. The open models ran locally or on a cloud host. The closed reference was GPT-5.4-mini.
- Task: one fixed single-turn prompt (a synthetic foreign-trade inquiry; tools `websearch`, `knowledge_base`, `fetchurl`; a 4-field `inquiry_analysis` schema). Extended check: 200+ prompt variants on one model.
- **5 rounds per model per condition**, temperature 0.5, streaming, max_completion_tokens 4096. No top_p, no seed, no confidence intervals.
- The paper doesn't say whether tools were executed and their results fed back in T1–T3. It counts whether a tool-call event shows up in the stream. Tool execution only happens in the two-pass mitigation.

## Metrics

- **TIR** (tool invocation rate): share of sessions with ≥1 valid tool call. Correctness of the tool or arguments is not scored.
- **SR** (suppression rate) = 1 − TIR_T2 / TIR_T1.
- **JCR** (JSON compliance rate): share of responses that validate against the schema.
- **ESR** (end-to-end success): tool invoked *and* valid structured output.
- **ATC**: average tool calls per successful session.

## Headline results (Table 7)

| Model | T1 TIR | T2 TIR | T3 JC |
|---|---|---|---|
| GPT-5.4-mini (closed) | 100% | 100% | 100% |
| Qwen3.6-35B-A3B (SGLang) | 100% | 0% | 100% |
| Qwen3.6-35B-A3B (vLLM) | 100% | 0% | 80% |
| Qwen3.5-122B-A10B | 100% | 0% | 100% |
| GPT-OSS-20B | 100% | 0% | 100% |
| Nemotron 3 Super | 100% | 0% | 100% |
| Qwen3.5-397B-A17B | 100% | 0% | 100% |
| Qwen3-VL-235B-Thinking | 100% | 0% | 100% |

- Every open model drops to 0% under T2. `tool_choice="required"` also gives 0% (Table 9; the model isn't named).
- Schema size makes no difference (1–3, 5–10 and 20+ fields all give 0%). Neither does fine-tuning (SFT, GRPO, 6k-sample SFT all give 0%).
- **Mechanism (their claim):** xgrammar compiles the schema into an FSM and masks logits each step. The token that opens a tool call (`<` of `<tool_call>` for Qwen) can never be generated. Traced on SGLang only. They frame "Constraint Priority Inversion" as a behavioural hypothesis on top of this.
- **Silent, not refused:** "the masking is silent—models generate schema-compliant outputs without indicating that tool calls were prevented." No errors are reported.

## Their mitigation: two-pass

Pass 1 runs with tools on and the schema off, and collects the tool results. Pass 2 runs with tools off and the schema on, with the results in context. TIR goes 0→100%, ESR 0→100%, LLM rounds 1→2. No latency or token numbers. The model and the n aren't stated. They don't test an answer-as-tool variant.

## What we do differently, and why it matters

1. **Hosted endpoints on OpenRouter**, not local SGLang/vLLM. We don't know each provider's engine or grammar backend. The interesting question becomes whether a hosted endpoint silently drops tools, errors out, or handles the combination (for example by not constraining while tools are present).
2. **Four outcomes, not one bit:** tool called / tool missing / explicit error or refusal / not supported (`require_parameters` routing failure). The paper only sees silent drops.
3. **We execute the fake tool and feed the result back**, so end-to-end success means the final JSON is valid *and* its values match the tool's data, which is stricter than the paper's ESR. We also report the paper's first-turn TIR so the two are comparable.
4. **15 tasks × 2 reps** per model and condition (n = 30), against the paper's one prompt × 5 rounds. We report Wilson 95% intervals.
5. **Temperature 0.5** to match the paper.
6. **Second workaround:** answer-as-tool (`submit_answer` with the schema as its parameters, no `response_format`).

## Weak spots in the paper (worth a line in the article, gently)

- n = 5 per cell, no intervals. Table/section cross-references are off (says "9-model matrix", lists 7).
- The claim that `<` "is not part of any valid JSON token sequence" is loose. `<` is legal inside a JSON string. Whether the mask blocks it depends on the FSM state (it does at the start of a value/object, which is where a tool call would begin).
