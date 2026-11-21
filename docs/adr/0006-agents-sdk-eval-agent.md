# A second eval agent built on the OpenAI Agents SDK

Status: accepted Nov 21, 2026. Extends [ADR 0004](0004-two-layer-agent-eval.md) and [ADR 0005](0005-local-models-in-the-agent-eval.md).

The eval agent in `evals/runner.ts` is a hand-rolled tool loop: it lists the server's tools, sends them to the model, runs each tool call through the MCP client and feeds the result back, for at most `MAX_TOOL_ROUNDS` model calls. Most agents that will use this server are not written that way. They are built on an agent framework that discovers MCP tools, runs the loop, retries and traces for them. A pass on the hand-rolled loop says nothing about whether the server works as well behind one of those.

So the runner now takes any `EvalAgent` (a function from a prompt and the MCP client to the tool calls made and the final answer), and `evals/agents-sdk.ts` adds one built on the **OpenAI Agents SDK** (`@openai/agents-core`, `@openai/agents-openai`). `EVAL_AGENT_IMPL=agents-sdk` selects it; `loop` stays the default. Both agents are graded by the same Layer 1 checks, judge, seeded controls and gate.

## Why the OpenAI Agents SDK

- It speaks MCP natively: an `Agent` takes `mcpServers`, and the SDK lists the tools, converts their schemas and runs the calls.
- It runs on any OpenAI-compatible Chat Completions endpoint, so it works with a local model through Ollama at no cost, as well as with OpenAI. The Claude Agent SDK needs an Anthropic key, which this repository does not hold (ADR 0004).
- Its MCP client is the same `@modelcontextprotocol/client` v2 this repository uses.

## How the comparison is kept fair

- The SDK reaches the server through `RecordingMcpServer`, an `MCPServer` adapter over the eval's in-memory MCP client. Every call is recorded by the same `recordToolCall` the loop uses, and the model sees the same tool text the loop sends it.
- Same system prompt (`AGENT_SYSTEM_PROMPT`), temperature 0, `MAX_AGENT_TOKENS`, no parallel tool calls, and `maxTurns` equal to `MAX_TOOL_ROUNDS`.
- A failed run is retried once, then recorded as an agent error, as the loop does per round. One difference: when the SDK runs out of turns it raises an error (an agent error), where the loop grades whatever text it had.
- On Ollama, `<think>...</think>` reasoning is stripped from the SDK agent's answer as it is from the loop's (ADR 0005).
- Both agents reach the same endpoint: the base URL and key come from one resolver (`resolveChatCompletionsEndpoint`), and the injected `fetch` is passed to the SDK's OpenAI client too.
- SDK tracing is turned off, so a local run sends nothing to OpenAI.

## Consequences

- `pnpm eval:compare` with `EVAL_AGENT_IMPL=agents-sdk` runs a model comparison on the SDK agent; the comparison records which implementation it ran, so a loop comparison and an SDK comparison on the same models and judge can be read side by side.
- CI still gates on the hand-rolled loop only, so a PR costs the same as before.
- The Agents SDK packages are dev dependencies: the published server does not depend on them.
