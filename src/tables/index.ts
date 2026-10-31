import { eisTables, epfTables, mtdTables, skbbkTables, socsoTables } from "./generated/index.js";
import { selectTable } from "./loader.js";
import type { EisTable, EpfTable, MtdTable, SkbbkTable, SocsoTable } from "./types.js";

export { NoTableInEffectError } from "./loader.js";
export type * from "./types.js";

/** The EPF Third Schedule in effect for a pay period (YYYY-MM). */
export function epfTableFor(payPeriod: string): EpfTable {
  return selectTable("epf", epfTables, payPeriod);
}

/** The SOCSO (Act 4) table in effect for a pay period (YYYY-MM). */
export function socsoTableFor(payPeriod: string): SocsoTable {
  return selectTable("socso", socsoTables, payPeriod);
}

/**
 * The SKBBK (Lindung 24 Jam) table in effect for a pay period (YYYY-MM). SKBBK starts with
 * June 2026 payroll, so earlier periods throw NoTableInEffectError: callers treat that as nothing
 * to pay, not as an invalid pay period.
 */
export function skbbkTableFor(payPeriod: string): SkbbkTable {
  return selectTable("skbbk", skbbkTables, payPeriod);
}

/** The EIS (Act 800) table in effect for a pay period (YYYY-MM). */
export function eisTableFor(payPeriod: string): EisTable {
  return selectTable("eis", eisTables, payPeriod);
}

/** LHDN's MTD (PCB) tax schedule in effect for a pay period (YYYY-MM). */
export function mtdTableFor(payPeriod: string): MtdTable {
  return selectTable("mtd", mtdTables, payPeriod);
}

/** Any generated rate table. */
export type RateTable = EpfTable | SocsoTable | SkbbkTable | EisTable | MtdTable;

export type TableKind = RateTable["kind"];

/** Every generated table, grouped by kind and oldest first within a kind. */
export const allTables: readonly RateTable[] = [
  ...epfTables,
  ...socsoTables,
  ...skbbkTables,
  ...eisTables,
  ...mtdTables,
];
