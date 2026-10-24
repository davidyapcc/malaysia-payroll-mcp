import { eisTables, epfTables, skbbkTables, socsoTables } from "./generated/index.js";
import { selectTable } from "./loader.js";
import type { EisTable, EpfTable, SkbbkTable, SocsoTable } from "./types.js";

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
