# malaysia-payroll-mcp

An MCP server that works out Malaysian statutory payroll deductions (EPF, SOCSO, EIS and MTD/PCB) for one resident employee's monthly salary, and cites the official rate table or rule behind every number.

**Status: pre-release.** The design and test data are done; the code arrives in Phase 1. Nothing is published to npm yet.

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
pnpm check          # Biome lint and format check, tsc, Vitest
pnpm test:coverage  # tests with v8 coverage
pnpm build          # compile to dist/
```

## Licence

[MIT](LICENSE)
