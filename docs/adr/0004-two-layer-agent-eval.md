# Agent evals gate CI on both deterministic tool use and an LLM-as-judge rubric

Our original plan checked only tool calls and numbers in the agent eval, avoiding prose assertions so LLM wording variance couldn't flake CI. However, in a regulated payroll workflow where every tool result returns structured citations, an agent that calls the right tool and prints the right RM total can still hallucinate a statutory rule, drop a mandatory disclaimer or misstate which party pays a contribution.

We therefore evaluate every eval case in two layers, and both gate CI:
1. **Deterministic tool-use check**: verifies the agent called the expected MCP tool, extracted arguments matching the golden case's inputs, and included every headline statutory RM amount from the golden case in its final answer.
2. **Model-based rubric (LLM-as-judge)**: grades the agent's final natural-language answer against the tool's returned `structuredContent` on citation faithfulness, completeness and clarity.

## Departure from the plan: the gate runs on OpenAI

The plan called for the cheapest Claude model. The gate instead runs on OpenAI, because it is the only provider key the repository holds: `gpt-4o` for both the agent and the judge. The Anthropic adapter (`claude-haiku-4-5`) is tested against mocks only and has not run live. Moving the gate to Claude is a follow-up for when an Anthropic key is available.

## Judge model

The judge runs on `gpt-4o`, not `gpt-4o-mini`. In the first live run (commit 340cd03), `gpt-4o-mini` caught only 2 of the 4 seeded controls, missing the disclaimer and the wrong RM total. It also invented errors in its rationales (for example "RM 66.40 instead of RM 66.40"), and it scored the SOC-05 answer, which silently retried after the refusal, 5/5/5. The rubric says that answer must score 1 or 2. The agent model is set separately by `EVAL_AGENT_MODEL`, also in `.github/workflows/ci.yml`; see the next section.

## Agent model

The agent runs on `gpt-4o`, not `gpt-4o-mini`. In the live run at 340cd03, `gpt-4o-mini` retried after the SOC-05 refusal and gave RM figures without telling the user that the opt-out was refused. A pass on `gpt-4o` shows the refusal check works with a capable agent. It does not show that every cheap model behaves this way, and it is not evidence about models that were not run. Every eval run now costs more than it did on `gpt-4o-mini`.

## Gate

- **Layer 1, standard cases**: at least 32 of the 34 standard cases must pass. The allowance of two misses is the named constant `LAYER1_ALLOWED_MISSES`, and the threshold is derived from it, not hard-coded.
- **Must-pass refusal cases**: any case with an `expectedError` (SOC-05 today) must pass Layer 1, or the gate fails whatever the suite count. The Scorecard reports this result separately and says when it caused the failure.
- **Layer 2 mean** of at least 4.0 out of 5.0, with **zero hallucinated citations**.
- **Party attribution**: EPF and SOCSO/EIS shares, and net pay's employee deductions and employer contributions, must be attributed to the right party by the answer. A figure that is named under the other party, or that the answer never attributes, fails. A figure that both parties pay may be named once for both.
- **Agent errors**: an agent round that fails is retried once. If the retry fails too, the case is recorded with an `agentError` and is not graded or judged. It is excluded from the rubric mean and counted in `agentErrors`. Any non-zero count fails the gate with its own message. In Layer 1 it counts as not passed, and if it is a must-pass case it is reported once, under agent errors.
- **Zero judge errors**: a judge call is retried once. A call that still fails (network, HTTP or unparseable reply) is counted in `judgeErrors`, is excluded from the rubric mean rather than scored 1/1/1, and fails the gate with its own message.
- **Seeded controls**: every control in `evals/controls.json` must be caught by the judge (see below).

## Refusal cases

For a case with an `expectedError`, Layer 1 allows retries after the expected refusal. The first tool call must use the expected tool and return the expected error. The answer fails if it affirms the opt-out, fails to explain the refusal, or presents RM amounts when no tool call succeeded (invented figures). Standard cases stay single-call.

## Seeded controls

`evals/controls.json` holds six deliberately bad answers, each with the tool output it contradicts: a made-up statute citation (the judge must flag a hallucinated citation), two answers missing the disclaimer (one terse, one well structured with sources, so polish cannot hide the gap), a swapped payer, a wrong RM total, and a silent SKBBK retry (the agent's refusal call is followed by figures and no refusal explanation). For the last five, the judge must score the named dimension at or below 3. Each live run sends them through the real judge. If the judge passes any control, the gate fails and the Scorecard lists the control. Controls are not part of the 35 cases or the rubric mean. Their correctness is tested with a fake judge that passes everything (the gate fails) and one that catches everything (the gate passes).

## Consequences

- Each eval case makes up to four LLM calls at temperature 0: up to three agent tool rounds (bounded by `MAX_TOOL_ROUNDS`), plus one judge call and one retry on failure. The six seeded controls add six judge calls per run.
- The Anthropic and OpenAI adapters share one `LlmClient` interface. Only OpenAI runs in CI.
- Because the judge may be wrong, its verdicts are checked by the seeded controls on every run. A judge that stops catching them fails CI.
- The layer-1 threshold tolerates prose variance without letting a refusal case slip through.
