# malaysia-payroll-mcp

An MCP server that works out Malaysian statutory payroll deductions (EPF, SOCSO, EIS and MTD/PCB) for one resident employee's monthly salary, and cites the official rate table or rule behind every number.

**Status: pre-release.** EPF, SOCSO, SKBBK and EIS are in; MTD and net pay come next. Nothing is published to npm yet.

## Tools

| Tool | What it works out |
| --- | --- |
| `calculate_epf` | EPF employee and employer contributions, from the Third Schedule in effect |
| `calculate_socso_eis` | SOCSO, SKBBK (Lindung 24 Jam) and EIS contributions, from the PERKESO tables in effect |

Every result echoes the pay period it used (the current month in Malaysia if you don't pass one), and carries citations, an explanation rendered from them, and a disclaimer.

## Resources

Every rate table the tools read is also a read-only resource, as JSON with amounts in sen: `payroll://tables/{kind}/{effectiveFrom}`, where `kind` is `epf`, `socso`, `skbbk` or `eis`. For example, `payroll://tables/epf/2025-10-01` is the EPF Third Schedule from 1 Oct 2025. `resources/list` shows them all, and the template completes both parts.

> Not tax advice and not LHDN-verified. Fixed monthly salaries only: overtime, commission, bonuses and arrears aren't supported.

## Docs

- [Architecture](docs/architecture.md): structure, stack and key decisions
- [Glossary](CONTEXT.md): the domain terms used in code and docs
- [Decision records](docs/adr/)
- [Official sources](docs/sources.md), with effective and retrieval dates
- [Golden test cases](docs/golden-cases.md), worked by hand from those sources
- [Rate tables](docs/data/) as CSV, the source of truth for every lookup

## Development

Needs Node 22 or later and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm check          # generated tables, Biome lint and format check, tsc, Vitest
pnpm gen:tables     # regenerate src/tables/generated/ after editing docs/data/
pnpm test:coverage  # tests with v8 coverage
pnpm build          # compile to dist/
```

To change a rate, edit or add a CSV in `docs/data/` (with its entry in `docs/data/sources.json`), run `pnpm gen:tables` and commit both. Never edit `src/tables/generated/` by hand: CI rejects it ([ADR 0003](docs/adr/0003-csv-rate-tables-are-canonical.md)).

## Licence

[MIT](LICENSE)
