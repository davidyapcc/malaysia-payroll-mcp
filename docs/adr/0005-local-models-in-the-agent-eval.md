# The agent eval can run on local open-weight models through Ollama

Status: accepted Nov 21, 2026. Extends [ADR 0004](0004-two-layer-agent-eval.md).

Every eval run in CI spends OpenAI credit on `gpt-4o`, and iterating on prompts, tool descriptions or the grader with a paid model is slow and costly. ADR 0004 also left an open question: it shows the gate passes on `gpt-4o`, and says nothing about cheaper or open-weight models.

So the eval harness gains an `ollama` provider. Ollama serves open-weight models on the developer's machine behind an OpenAI-compatible Chat Completions endpoint, so the existing OpenAI adapter is reused with a configurable base URL (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`), no API key, and `max_tokens` in place of `max_completion_tokens`. For Ollama only, reasoning that some open-weight models put in the answer as `<think>...</think>` is stripped before grading, so the grader and the judge see only the answer the user would. OpenAI answers are passed through unchanged.

The judge can run on a different provider from the agent (`EVAL_JUDGE_PROVIDER`). That separates two questions: how well a local model works as the **agent** (graded by a judge already shown to catch the seeded controls), and whether a local model is good enough to be the **judge** (the seeded controls answer that on every run, as they do for `gpt-4o`).

`pnpm eval:compare` produces a **model comparison** (see `CONTEXT.md`): the full suite several times per model (`EVAL_COMPARE_MODELS`, `EVAL_COMPARE_RUNS`, default 3), every model graded by the one judge `EVAL_JUDGE_MODEL` names. The judge model is required, not defaulted, because a judge that changed between rows would make the rows incomparable. It writes gate passes, Layer 1 pass rate with its min and max across runs, must-pass failures (agent errors are counted once, under agent errors, as in ADR 0004), the rubric mean over every case the judge scored (unscored cases and runs are excluded, not averaged in as zero), hallucinated citations, agent and judge errors, controls caught, case latency, minutes per run, and the hardware read from `node:os`. It never fails on the gate; `pnpm eval` stays the gate.

## Consequences

- Local runs cost nothing, so prompt and grader changes can be tried many times before a paid run.
- CI is unchanged: GitHub-hosted runners have no GPU, and the gate stays on `gpt-4o` (ADR 0004).
- Runs with a local model default to one case at a time (`EVAL_CONCURRENCY` overrides it), because a local model mostly queues parallel requests.
- Results from a local model are evidence about that model, quantisation and machine only. Each model comparison records the model tags and the hardware it ran on.
