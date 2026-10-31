# malaysia-payroll-mcp

An MCP server that works out Malaysian statutory payroll deductions (EPF, SOCSO, SKBBK, EIS and MTD/PCB) for one employee's monthly salary, and cites the official rate table or rule behind every number.

**Status: pre-release.** EPF, SOCSO, SKBBK, EIS, MTD and net pay are in. An agent eval is planned. Version 0.1.0 is tagged on GitHub; nothing is published to npm yet.

## Tools

| Tool | What it works out |
| --- | --- |
| `calculate_epf` | EPF employee and employer contributions, from the Third Schedule in effect |
| `calculate_socso_eis` | SOCSO, SKBBK (Lindung 24 Jam) and EIS contributions, from the PERKESO tables in effect |
| `calculate_mtd` | MTD (PCB) income tax deduction: LHDN's formula with the working shown for a tax resident, or the flat 30% for a non-resident (`taxResident: false`). Standard reliefs only (individual, spouse, children, EPF, plus a TP1 total) |
| `calculate_net_pay` | One month's payslip: every deduction above, net pay, and the employer's contributions and total cost. Runs the three calculators in one call and feeds the employee EPF into MTD |

Every result echoes the pay period it used (the current month in Malaysia if you don't pass one), and carries citations, an explanation rendered from them, and a disclaimer.

## Resources

Every rate table the tools read is also a read-only resource, as JSON with amounts in sen: `payroll://tables/{kind}/{effectiveFrom}`, where `kind` is `epf`, `socso`, `skbbk`, `eis` or `mtd` (LHDN's tax schedule). For example, `payroll://tables/epf/2025-10-01` is the EPF Third Schedule from 1 Oct 2025. `resources/list` shows them all, and the template completes both parts.

> Not tax advice, and not verified by KWSP, PERKESO or LHDN. Fixed monthly salaries only: overtime, commission, bonuses and arrears aren't supported, and neither is zakat.

## Install

Nothing is on npm yet, so build from source. You need Node 22 or later and pnpm.

```sh
git clone https://github.com/davidyapcc/malaysia-payroll-mcp.git
cd malaysia-payroll-mcp
pnpm install
pnpm build
```

## Usage

The server runs over stdio. Replace `/absolute/path/to` with where you cloned it.

**Claude Code:**

```sh
claude mcp add malaysia-payroll -- node /absolute/path/to/malaysia-payroll-mcp/dist/entry/stdio.js
```

**Claude Desktop**, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "malaysia-payroll": {
      "command": "node",
      "args": ["/absolute/path/to/malaysia-payroll-mcp/dist/entry/stdio.js"]
    }
  }
}
```

### Example

Calling `calculate_epf` with these arguments:

```json
{ "monthlySalary": 5000, "age": 34, "citizenship": "malaysian", "payPeriod": "2026-10" }
```

returns the following (amounts in RM, output from a real run):

```json
{
  "payPeriod": "2026-10",
  "monthlySalary": 5000,
  "part": "A",
  "employee": 550,
  "employer": 650,
  "total": 1200,
  "citations": [
    {
      "item": "EPF",
      "employee": 550,
      "employer": 650,
      "rule": "Part A applies to Malaysians, permanent residents and non-Malaysians registered before 1 Aug 1998, under 60. Up to RM20,000 the schedule's band amounts apply.",
      "tableRow": "Part A, RM4,980.01 to RM5,000.00",
      "source": {
        "title": "EPF Act 1991, Third Schedule (from 1 October 2025)",
        "url": "https://www.kwsp.gov.my/documents/d/guest/third_schedule_from_-1-october-2025",
        "retrieved": "2026-10-23"
      },
      "effectiveFrom": "2025-10-01"
    }
  ],
  "explanation": "EPF: employee RM550.00, employer RM650.00. Part A applies to Malaysians, permanent residents and non-Malaysians registered before 1 Aug 1998, under 60. Up to RM20,000 the schedule's band amounts apply. Table row: Part A, RM4,980.01 to RM5,000.00. Source: EPF Act 1991, Third Schedule (from 1 October 2025), in effect from 2025-10-01.",
  "disclaimer": "Not tax or legal advice, and not verified by KWSP, PERKESO or LHDN. Fixed monthly salaries only: overtime, commission, bonuses and arrears are not supported. Check results against the cited source."
}
```

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
