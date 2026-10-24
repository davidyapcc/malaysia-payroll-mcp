import { type EpfBand, type EpfPart, epfTableFor } from "../tables/index.js";
import { type Citation, renderExplanation } from "./citation.js";
import { type Citizenship, monthlySalarySen } from "./employee.js";
import { tableInEffect } from "./errors.js";
import { ceilPerMilleToRinggit, formatRm, toRm } from "./money.js";
import { resolvePayPeriod } from "./pay-period.js";

export interface EpfInput {
  /** RM, at most 2 decimal places (see CONTEXT.md). */
  readonly monthlySalary: number;
  readonly age: number;
  readonly citizenship: Citizenship;
  /** Only matters for non-Malaysians: those registered before 1 Aug 1998 follow Parts A and C. */
  readonly registeredWithEpfBefore1Aug1998?: boolean | undefined;
  /** YYYY-MM. Defaults to the current month in Malaysia. */
  readonly payPeriod?: string | undefined;
}

export interface EpfResult {
  readonly payPeriod: string;
  readonly monthlySalary: number;
  /** The Third Schedule part applied. F has no table: 2% each of the wages. */
  readonly part: EpfPart | "F";
  readonly employee: number;
  readonly employer: number;
  readonly total: number;
  readonly citations: readonly Citation[];
  readonly explanation: string;
}

/** Per-mille rates: above RM20,000 for the table parts (the note in each part), and Part F. */
const RATES: Readonly<Record<EpfPart | "F", { employee: number; employer: number }>> = {
  A: { employee: 110, employer: 120 },
  C: { employee: 55, employer: 60 },
  E: { employee: 0, employer: 40 },
  F: { employee: 20, employer: 20 },
};

const WHO: Readonly<Record<EpfPart | "F", string>> = {
  A: "Part A applies to Malaysians, permanent residents and non-Malaysians registered before 1 Aug 1998, under 60.",
  C: "Part C applies to permanent residents and non-Malaysians registered before 1 Aug 1998, aged 60 and over.",
  E: "Part E applies to Malaysians aged 60 and over: the employer pays, the employee pays nothing.",
  F: "Part F applies to non-Malaysians registered from 1 Aug 1998: 2% employee and 2% employer, worked out on the wages, not a table.",
};

const ROUNDING = "Each share is rounded up to the next ringgit separately.";

function partFor(input: EpfInput): EpfPart | "F" {
  if (input.citizenship === "non_malaysian" && input.registeredWithEpfBefore1Aug1998 !== true) {
    return "F";
  }
  if (input.age < 60) return "A";
  return input.citizenship === "malaysian" ? "E" : "C";
}

/** EPF contributions for one month, from the Third Schedule in effect for the pay period. */
export function calculateEpf(input: EpfInput, options: { now?: Date } = {}): EpfResult {
  const wages = monthlySalarySen(input.monthlySalary);
  const payPeriod = resolvePayPeriod(input.payPeriod, options.now);
  const table = tableInEffect(epfTableFor, payPeriod);
  const part = partFor(input);

  const band: EpfBand | undefined =
    part === "F" ? undefined : table.parts[part].find((b) => b.above < wages && wages <= b.upTo);
  const rates = RATES[part];
  const employee = band?.employee ?? ceilPerMilleToRinggit(wages, rates.employee);
  const employer = band?.employer ?? ceilPerMilleToRinggit(wages, rates.employer);

  let rule: string;
  if (band !== undefined) rule = `${WHO[part]} Up to RM20,000 the schedule's band amounts apply.`;
  else if (part === "F") rule = `${WHO[part]} ${ROUNDING}`;
  else {
    rule = `${WHO[part]} Above RM20,000: ${pct(rates.employee)} employee and ${pct(rates.employer)} employer of the wages. ${ROUNDING}`;
  }

  const citation: Citation = {
    item: "EPF",
    employee: toRm(employee),
    employer: toRm(employer),
    rule,
    ...(band === undefined
      ? {}
      : { tableRow: `Part ${part}, ${formatRm(band.above + 1)} to ${formatRm(band.upTo)}` }),
    source: table.source,
    effectiveFrom: table.effectiveFrom,
  };
  const citations = [citation];
  return {
    payPeriod,
    monthlySalary: toRm(wages),
    part,
    employee: toRm(employee),
    employer: toRm(employer),
    total: toRm(employee + employer),
    citations,
    explanation: renderExplanation(citations),
  };
}

function pct(perMille: number): string {
  return `${perMille / 10}%`;
}
