# Architecture: malaysia-payroll-mcp

Status: design decided Oct 24, 2026, after an architecture review; partly built. This covers v1 (one resident employee, one month). Domain terms are defined in [CONTEXT.md](../CONTEXT.md). The decisions that are hard to undo or surprising have their own records in [adr/](adr/).

The goal is statutory payroll numbers an agent can rely on: correct, traceable to an official source, and tested. Where goals conflict, choose what someone can see and verify: tests, provenance and a citation behind every number.

**Built today:** `calculate_epf`, `calculate_socso_eis`, the rate tables and their resources, the stdio entry point, and CI for lint, types, generated tables and tests. **Planned, not built:** everything marked "planned" below, including MTD, net pay, the agent eval, the hosted endpoint, npm publishing and the MCP Registry listing.

## Repository layout

This repo holds the code and every doc needed to work on it: this file, `CONTEXT.md`, `adr/`, `sources.md`, `golden-cases.md` and the rate tables in `data/`. The project plan and roadmap live in a separate, private planning repo, which keeps a clone of this one in an ignored folder rather than a submodule, because nothing there needs to pin an app commit.

## App structure

```
malaysia-payroll-mcp/
├── CONTEXT.md                 # domain glossary
├── docs/
│   ├── architecture.md
│   ├── adr/
│   ├── sources.md
│   ├── golden-cases.md        # rationale for each case; the data lives in test/golden/
│   └── data/                  # rate tables: the source of truth (ADR 0003)
│       ├── *.csv              # <kind>-<description>-from-<YYYY-MM-01>.csv
│       └── sources.json       # title, URL and retrieval date for each CSV
├── scripts/
│   └── gen-tables.ts          # CSV -> src/tables/generated/*.ts
├── src/
│   ├── core/                  # pure functions, no MCP imports
│   │   ├── money.ts           # integer sen and rounding helpers
│   │   ├── pay-period.ts      # parse, default to the current month in Malaysia time
│   │   ├── epf.ts
│   │   ├── socso-eis.ts
│   │   ├── mtd.ts             # planned
│   │   ├── net-pay.ts         # planned
│   │   └── citation.ts        # Citation type, builders, explanation text
│   ├── tables/
│   │   ├── loader.ts          # pick a table by effective date (country-neutral)
│   │   ├── types.ts           # row shapes of the generated tables, in sen
│   │   ├── index.ts           # epfTableFor, socsoTableFor, eisTableFor
│   │   └── generated/*.ts     # committed; CI checks they match the CSVs
│   ├── mcp/
│   │   ├── server.ts          # registers tools and resources
│   │   ├── tools/*.ts         # zod schemas plus thin adapters into core
│   │   └── resources.ts       # tables exposed as resources
│   └── entry/
│       ├── stdio.ts           # bin entry for Claude Desktop and Claude Code
│       └── worker.ts          # planned: Cloudflare Worker, streamable HTTP (v1.1)
├── test/
│   ├── golden/cases.json      # one file, IDs match golden-cases.md
│   └── *.test.ts
├── evals/                     # planned
│   ├── cases.jsonl            # about 30 prompts with expected tool, args and total
│   └── run.ts
├── server.json                # planned: MCP Registry manifest
└── .github/
    ├── dependabot.yml
    └── workflows/{ci,publish}.yml  # publish.yml is planned
```

**`core/` never imports from `mcp/`.** The calculations stay plain functions that can be tested without a server, and the MCP layer is a thin adapter on top. That keeps 100% core coverage cheap and lets a later country server reuse the core. Keep `money.ts`, `citation.ts` and `tables/loader.ts` free of Malaysia-specific logic, so they can move into a shared package if a second country happens.

**Entry points are thin too.** `worker.ts` (planned) only wires the SDK's web-standard HTTP transport to the server. Moving to AWS Lambda later means adding a `lambda.ts` next to it, not changing the server.

## Stack

| Concern | Choice |
| --- | --- |
| Language and runtime | TypeScript, ESM only, Node `>=22` (CI tests 22, 24 and 26) |
| MCP SDK | `@modelcontextprotocol/server` `^2.4.0` (v2, stable since Jul 27, 2026; replaces `@modelcontextprotocol/sdk`) |
| Schemas | zod 4 (required by SDK v2), for every tool input and output |
| Package manager | pnpm |
| Build | plain `tsc`, no bundler. With TS 6 or later, add `"types": ["node"]` to tsconfig (the SDK's types reference `Buffer`). |
| Lint and format | Biome |
| Tests | Vitest with v8 coverage |
| Agent eval (planned) | custom `evals/run.ts`: Anthropic SDK tool-use loop against the server through `InMemoryTransport` |
| Hosting (planned, v1.1) | Cloudflare Workers. AWS Lambda may be tried later as a learning exercise. |

## Key design decisions

**Money is held as integers (sen), never floats.** Statutory tables round in specific ways, and floating-point drift would break golden tests in ways that are hard to see. Inputs are accepted in RM with at most 2 decimal places at the tool boundary and converted once.

**One monthly salary input (ADR 0001).** v1 uses the same monthly salary for every statute. Overtime, commission, bonuses and arrears aren't supported, and the tool descriptions say so.

**Tables are data, chosen by effective date (ADR 0003).** CSVs are canonical. Each generated table carries `effectiveFrom`, `source` (title, URL, retrieval date) and its rows. The loader picks the newest table in effect for the pay period. Adding Budget 2027 rates is a new CSV, not a code change.

**`payPeriod` is optional and always echoed.** It defaults to the current month in `Asia/Kuala_Lumpur`, and every result states the pay period it used. Tests and evals always pass it, so they don't depend on the clock. A pay period before the earliest table is a validation error.

**Band lookups match on upper bounds.** Every lookup is stored as `(above, upTo]` and matched with `above < x <= upTo`, so wages with cents never fall into a gap. EPF, SOCSO and EIS use the wage as is. **MTD is the exception (ADR 0002):** P keeps its cents, but the tax band and the RM400 rebate are picked on P floored to whole ringgit, as LHDN's online calculator does.

**Rounding rules live with each table.** EPF: whole ringgit, each share rounded up separately. MTD: truncate intermediate values to 2 decimal places, then round the result up to the next 5 sen. SOCSO and EIS: exact table amounts, no rounding.

**Inputs that can't be derived from anything else.** `skbbkStatus` (covered by default, can only be opted out with PERKESO's approval, locals only) and `eisPayableBefore57`. Neither can be worked out from age or date of birth.

**Every result carries citations and an explanation.** Each number comes with a `Citation { rule, tableRow?, source, effectiveFrom }`, and each result has a short `explanation` rendered from those citations, so the explanation can never disagree with the number. There's no separate `explain_calculation` tool: it would make the agent send the whole result back for a second round trip, which is one more way to fail the eval.

**Stateless, no auth, no storage.** Nothing is kept between calls.

**Hosted endpoint (planned): no bodies in logs.** Salary and age are personal data under PDPA even when nothing is stored. The Worker logs only the tool name, status and latency, never request or response bodies, and it rate-limits per IP. The README has a short privacy note saying so.

**A disclaimer in every response.** Each tool result has a short field: not tax advice, not LHDN-verified, fixed salaries only.

## Tool contract (sketch)

| Tool | Key inputs | Output |
| --- | --- | --- |
| `calculate_epf` | `monthlySalary`, `age`, `citizenship`, `registeredWithEpfBefore1Aug1998?`, `payPeriod?` | employee and employer shares, citations, explanation |
| `calculate_socso_eis` | `monthlySalary`, `age`, `citizenship`, `skbbkStatus?` (default `covered`), `eisPayableBefore57?` (required from 57 to 59), `payPeriod?` | SOCSO, SKBBK and EIS shares, band, citations, explanation |
| `calculate_mtd` (planned) | `monthlySalary`, `ytdSalary`, `ytdMtd`, `ytdEpf`, `maritalStatus`, `children`, `payPeriod?` | MTD amount, citations, explanation |
| `calculate_net_pay` (planned) | union of the above | payslip breakdown and net pay, citations, explanation |

Inputs and outputs are zod schemas, registered with `outputSchema` and returned as `structuredContent`, so a bad input gives the agent a clear validation error it can fix.

Resources: `payroll://tables/{kind}/{effectiveFrom}`, for example `payroll://tables/epf/2025-10-01`.

## Testing and quality gates

| Layer | Tool | Runs | Gate |
| --- | --- | --- | --- |
| Lint, format and types | Biome, `tsc --noEmit` | every PR | required |
| Generated tables up to date | `pnpm gen:tables:check` (fails on any changed, missing or stale generated file) | every PR | required |
| Golden unit tests | Vitest | every PR, Node 22, 24 and 26 | required, 100% coverage of `src/` except `src/entry/` |
| MCP contract | Vitest plus `InMemoryTransport` client | every PR | required |
| Agent eval (planned) | `evals/run.ts`, cheapest Claude model that passes, temperature 0 | same-repo PRs that touch `src/` or `evals/` | required, pass threshold 28/30 |
| Manual | MCP Inspector, Claude Desktop, Claude Code | before each tag | checklist |

**Eval cost and key exposure (planned).** Every eval run spends Claude API credits, and fork PRs can't see secrets. So the eval runs only on same-repo PRs (`pull_request` event, never `pull_request_target`), and fork PRs run unit tests only. It uses the cheapest capable model, runs cases in parallel with a hard `max_tokens`, is skipped when `src/` and `evals/` are unchanged, and the API key has a monthly spend limit.

## Release and infrastructure

Planned: nothing below has been released yet. The package version is still 0.0.0.

- **Versioning.** A new rate table is a minor version. So is any fix that changes a number, with a "results changed" note in the release notes, never a quiet patch. A schema change that breaks callers is a major version. Patch versions cover everything else.
- **Publishing.** Pushing a `v*` tag runs `publish.yml`. It publishes to npm through trusted publishing (OIDC, needs `id-token: write`, provenance is automatic), then to the MCP Registry with `mcp-publisher login github-oidc`. No npm token is stored. The first npm publish is probably manual, so trusted publishing can be configured on an existing package. Publish runs on Node 24.
- **Registry identity.** `server.json` `name` and `package.json` `mcpName` are both `io.github.davidyapcc/malaysia-payroll-mcp`. Bump the version in both files. The Registry is still in preview and may reset, so don't treat the listing as permanent.
- **Distribution.** v1.0 ships over stdio only (`npx -y malaysia-payroll-mcp`). No MCPB bundle. v1.1 adds the Cloudflare Workers endpoint, which works as an authless custom connector in claude.ai (paid plans).
- **Dependencies.** Dependabot, weekly, minor and patch updates grouped into one PR. CI and the eval gate decide whether it merges.

## Open decisions

None for v1. Revisit Lambda after v1.1 if it's still useful as a learning exercise.
