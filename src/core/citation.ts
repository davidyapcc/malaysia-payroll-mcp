// Country-neutral: the record behind each output number, and the explanation rendered from it.
import type { TableSource } from "../tables/loader.js";
import { formatRm } from "./money.js";

/** The record behind one output line (see CONTEXT.md). Amounts are in RM. */
export interface Citation {
  /** The contribution or tax the numbers are for, for example "EPF". */
  readonly item: string;
  readonly employee: number;
  readonly employer: number;
  /** The rule applied, as a sentence. */
  readonly rule: string;
  /** The rate-table band used, when the numbers come from one. */
  readonly tableRow?: string;
  readonly source: TableSource;
  /** The effective date (YYYY-MM-DD) of the rate table cited. */
  readonly effectiveFrom: string;
}

/** One line per citation, so the explanation can never disagree with the numbers. */
export function renderExplanation(citations: readonly Citation[]): string {
  return citations
    .map((c) =>
      [
        `${c.item}: employee ${rm(c.employee)}, employer ${rm(c.employer)}.`,
        c.rule,
        ...(c.tableRow === undefined ? [] : [`Table row: ${c.tableRow}.`]),
        `Source: ${c.source.title}, in effect from ${c.effectiveFrom}.`,
      ].join(" "),
    )
    .join("\n");
}

function rm(amount: number): string {
  return formatRm(Math.round(amount * 100));
}
