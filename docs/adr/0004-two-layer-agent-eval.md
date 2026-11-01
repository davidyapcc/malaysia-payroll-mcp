# Agent evals gate CI on both deterministic tool use and an LLM-as-judge rubric

Our original plan checked only tool calls and numbers in the agent eval, avoiding prose assertions so LLM wording variance couldn't flake CI. However, in a regulated payroll workflow where every tool result returns structured citations, an agent that calls the right tool and prints the right RM total can still hallucinate a statutory rule, drop a mandatory disclaimer or misstate which party pays a contribution.

We therefore evaluate every eval case in two layers, and both gate CI:
1. **Deterministic tool-use check**: verifies the agent called the expected MCP tool, extracted arguments matching the golden case's inputs, and included every headline statutory RM amount from the golden case in its final answer.
2. **Model-based rubric (LLM-as-judge)**: grades the agent's final natural-language answer against the tool's returned `structuredContent` on citation faithfulness, completeness and clarity.

## Consequences

- Every eval case makes two LLM calls (the agent under test and the judge) at temperature 0, doubling API token usage per run in exchange for catching citation hallucinations.
- To prevent prose variance from making CI brittle, the gate uses suite-level thresholds (`>= 33/35` deterministic passes and `>= 4.0/5.0` mean rubric score, with zero tolerance for fabricated statutory citations) rather than requiring perfect prose on every case.

