# Changelog

Versioning rules are in [docs/architecture.md](docs/architecture.md#release-and-infrastructure).

## 0.3.0 (2026-11-22)

No tool results changed: every number the server returns is the same as in 0.2.0.

### Added

- A two-layer agent eval (`pnpm eval`, [ADR 0004](docs/adr/0004-two-layer-agent-eval.md)). Layer 1 checks tool choice, arguments and refusals with fixed rules. Layer 2 has an LLM judge score each answer, and 6 seeded bad answers check the judge every run. It gates pull requests that touch the server or the eval.
- Agent eval on local open-weight models through Ollama (`EVAL_PROVIDER=ollama`, `pnpm eval:local`), with no API key or cost ([ADR 0005](docs/adr/0005-local-models-in-the-agent-eval.md)).
- `EVAL_JUDGE_PROVIDER` to run the judge on a different provider from the agent, and `OPENAI_BASE_URL` for OpenAI-compatible endpoints.
- `pnpm eval:compare`: a model comparison, with repeated runs per model graded by one fixed judge and the hardware they ran on.
- A second eval agent built on the OpenAI Agents SDK (`EVAL_AGENT_IMPL=agents-sdk`), graded by the same checks and judge as the hand-rolled loop ([ADR 0006](docs/adr/0006-agents-sdk-eval-agent.md)).
- Publishing: each version tag publishes to npm with provenance through trusted publishing (no stored token) and lists the server on the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.davidyapcc/malaysia-payroll-mcp` (`server.json`).

### Changed

- Every tool description now asks the agent to include the result's disclaimer in its answer.
- The error for a foreign worker's SKBBK opt-out now tells the agent what to do next: tell the user the opt-out isn't available, and label any figures it gives as `skbbkStatus: covered`.
- Dependency and GitHub Actions updates. The new SDK packages are dev dependencies only, so installing the server pulls in nothing new.

## 0.2.0 (2026-11-01)

### Added

- `calculate_mtd`: MTD (PCB) income tax deduction with LHDN's formula and the working shown. Residents get standard reliefs only (individual, spouse, children, EPF, plus a TP1 total). Set `taxResident: false` for the flat 30% non-resident rate.
- `calculate_net_pay`: combines EPF, SOCSO, SKBBK, EIS and MTD into a payslip breakdown.
- LHDN's 2026 tax schedule as a rate table and a read-only resource (`payroll://tables/mtd/2026-01-01`).
- Install and usage instructions in the README, including client config.

### Changed

- `calculate_mtd` and `calculate_net_pay` now reject inputs that can't be true, with an error the caller can act on:
  - `epfEmployee` above `monthlySalary`
  - `yearToDate.epf` or `yearToDate.mtd` above `yearToDate.remuneration`
  - non-zero `yearToDate` figures in January
- Node 24 or later is now required.
- The docs now mark unbuilt work as planned.

## 0.1.0

First tagged version: `calculate_epf`, `calculate_socso_eis`, and the EPF, SOCSO, SKBBK and EIS rate tables as read-only resources. Results carry citations, an explanation and a disclaimer.
