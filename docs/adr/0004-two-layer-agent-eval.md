# Agent evals gate CI on both deterministic tool use and an LLM-as-judge rubric

Our original plan checked only tool calls and numbers in the agent eval, avoiding prose assertions so LLM wording variance couldn't flake CI. However, in a regulated payroll workflow where every tool result returns structured citations, an agent that calls the right tool and prints the right RM total can still hallucinate a statutory rule, drop a mandatory disclaimer or misstate which party pays a contribution.

We therefore evaluate every eval case in two layers, and both gate CI:
1. **Deterministic tool-use check**: verifies the agent called the expected MCP tool, extracted arguments matching the golden case's inputs, and included every headline statutory RM amount from the golden case in its final answer.
2. **Model-based rubric (LLM-as-judge)**: grades the agent's final natural-language answer against the tool's returned `structuredContent` on citation faithfulness, completeness and clarity.

## Departure from the plan: the gate runs on OpenAI

The plan called for the cheapest Claude model. The gate instead runs on OpenAI (`gpt-4o-mini` for the agent and the judge), because it is the only provider key the repository holds. The Anthropic adapter (`claude-haiku-4-5`) is tested against mocks only and has not run live. Moving the gate to Claude is a follow-up for when an Anthropic key is available.

## Gate

- **Layer 1, standard cases**: at least 32 of the 34 standard cases must pass. The allowance of two misses is the named constant `LAYER1_ALLOWED_MISSES`, and the threshold is derived from it, not hard-coded.
- **Must-pass refusal cases**: any case with an `expectedError` (SOC-05 today) must pass Layer 1, or the gate fails whatever the suite count. The Scorecard reports this result separately and says when it caused the failure.
- **Layer 2 mean** of at least 4.0 out of 5.0, with **zero hallucinated citations**.
- **Zero judge errors**: a judge call is retried once. A call that still fails (network, HTTP or unparseable reply) is counted in `judgeErrors`, is excluded from the rubric mean rather than scored 1/1/1, and fails the gate with its own message.
- **Seeded controls**: every control in `evals/controls.json` must be caught by the judge (see below).

## Refusal cases

For a case with an `expectedError`, Layer 1 allows retries after the expected refusal. The first tool call must use the expected tool and return the expected error. The answer fails if it affirms the opt-out, fails to explain the refusal, or presents RM amounts when no tool call succeeded (invented figures). Standard cases stay single-call.

## Seeded controls

`evals/controls.json` holds four deliberately bad answers, each with the tool output it contradicts: a made-up statute citation (the judge must flag a hallucinated citation), a missing disclaimer, a swapped payer, and a wrong RM total (for the last three, the judge must score the named dimension at or below 3). Each live run sends them through the real judge. If the judge passes any control, the gate fails and the Scorecard lists the control. Controls are not part of the 35 cases or the rubric mean. Their correctness is tested with a fake judge that passes everything (the gate fails) and one that catches everything (the gate passes).

## Consequences

- Each eval case makes up to four LLM calls at temperature 0: up to three agent tool rounds (bounded by `MAX_TOOL_ROUNDS`), plus one judge call and one retry on failure. The four seeded controls add four judge calls per run.
- The Anthropic and OpenAI adapters share one `LlmClient` interface. Only OpenAI runs in CI.
- Because the judge may be wrong, its verdicts are checked by the seeded controls on every run. A judge that stops catching them fails CI.
- The layer-1 threshold tolerates prose variance without letting a refusal case slip through.
