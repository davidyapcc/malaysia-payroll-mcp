# Changelog

Versioning rules are in [docs/architecture.md](docs/architecture.md#release-and-infrastructure).

## 0.2.0 (unreleased)

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
