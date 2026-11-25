# Phase 0 notes (24 Nov 2026)

## Paper
The source is arXiv **2606.25605** ("Constraint Tax in Open-Weight LLMs"), not 2604.25359. See `PAPER.md` for its conditions, metrics, results, and how our setup differs.

## Frozen models (`models.json`, frozen 2026-11-24)
These are the 8 free models that advertise `tools` plus `response_format` and/or `structured_outputs`. `candidates.json` has the full list of 11 free candidates.

| Model | Maker | Endpoint | Notes |
|---|---|---|---|
| inclusionai/ling-3.2-flash:free | inclusionAI | Ant Digital, fp8 | all params advertised |
| baidu/ernie-5.5-flash-preview:free | Baidu | Baidu | all params advertised |
| liquid/lfm-3-1.7b:free | Liquid | Liquid | 1.7B, the smallest |
| particle-ai/particle-1:free | Particle AI | Particle AI | **no HF id: open weights unconfirmed** |
| recursive/flint-v1.0:free | Recursive | Recursive, bf16 | **no `tool_choice`**, `response_format` only |
| nvidia/nemotron-3.5-super-vl:free | NVIDIA | Nvidia | **endpoint status −2 (degraded) at freeze** |
| google/gemma-4-31b-it:free | Google | AI Studio | `response_format` only, no `structured_outputs` |
| google/gemma-4-26b-a4b-it:free | Google | AI Studio | `response_format` only, no `structured_outputs` |

Excluded: the free endpoints for nemotron-3.5-lightning, nemotron-3-ultra and nemotron-3-nano-omni advertise tools but no `response_format`, and `openrouter/free` is a router.

**Paid controls:**
- `openai/gpt-5.4-mini` is the closed control. It is also the paper's closed reference model.
- `google/gemma-4-31b-it` (paid, 18 endpoints) is the open-paid control. It compares the same weights on a different endpoint.

## Smoke test
Planned: 1 task × 4 conditions × 2 models, ≈14 free requests. Status: **pending.** It needs `OPENROUTER_API_KEY`.

## Projections
| Run | Sessions | Requests (est.) |
|---|---|---|
| Main, free (8 × 4 × 15 × 2) | 960 | ~1,680 |
| Workarounds, free (8 × 2 strategies × 15 × 2, ~2 req each) | 480 | ~960 |
| **Free total** | | **~2,640 → 3 days at 900/day** |
| Main, paid controls | 240 | ~420 → **~$0.71** |
| Workarounds, paid controls | 120 | ~240 → **~$0.40** |
| **Paid total** | | **~$1.1 (cap with `--max-usd 3`)** |

The cost estimate assumes 1,500 prompt + 400 completion tokens per request. GPT-5.4-mini accounts for about 95% of the paid cost.

## npm
Both `tool-schema-safe` and `constraint-tax` are unclaimed on npm (404, 24 Nov 2026).

## Design choices worth knowing
- Every condition sends the same prompt, which describes the JSON fields in words, so `tools-only` answers can also be checked against the schema.
- `tool_choice: "required"` applies to turn 1 only; otherwise the model could never answer.
- The fake tool is executed and its result fed back (up to 4 turns). End-to-end success requires the correct tool and args, schema-valid JSON, and values that match the tool output. First-turn TIR is reported separately so it can be compared with the paper.
- Temperature is 0.5, matching the paper. Every request sets `provider.require_parameters: true`.
