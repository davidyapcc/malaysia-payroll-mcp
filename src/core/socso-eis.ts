import {
  eisTableFor,
  NoTableInEffectError,
  type SkbbkTable,
  skbbkTableFor,
  socsoTableFor,
} from "../tables/index.js";
import { type Citation, renderExplanation } from "./citation.js";
import { type Citizenship, monthlySalarySen } from "./employee.js";
import { PayrollInputError, tableInEffect } from "./errors.js";
import { formatRm, toRm } from "./money.js";
import { resolvePayPeriod } from "./pay-period.js";

export type SkbbkStatus = "covered" | "opted_out";

export interface SocsoEisInput {
  /** RM, at most 2 decimal places (see CONTEXT.md). */
  readonly monthlySalary: number;
  readonly age: number;
  readonly citizenship: Citizenship;
  /** Defaults to covered. Only locals can opt out, and only with PERKESO's approval. */
  readonly skbbkStatus?: SkbbkStatus | undefined;
  /** Required from 57 to 59: whether EIS contributions were payable before the employee was 57. */
  readonly eisPayableBefore57?: boolean | undefined;
  /** YYYY-MM. Defaults to the current month in Malaysia. */
  readonly payPeriod?: string | undefined;
}

export interface SocsoEisResult {
  readonly payPeriod: string;
  readonly monthlySalary: number;
  readonly skbbkStatus: SkbbkStatus;
  readonly socso: {
    readonly category: "first" | "second";
    readonly employee: number;
    readonly employer: number;
  };
  /** Employee only. 0 when opted out or before June 2026. */
  readonly skbbk: { readonly employee: number };
  readonly eis: { readonly covered: boolean; readonly employee: number; readonly employer: number };
  readonly totals: { readonly employee: number; readonly employer: number };
  readonly citations: readonly Citation[];
  readonly explanation: string;
}

interface Band {
  readonly no: number;
  readonly above: number;
  readonly upTo: number | null;
}

/** PERKESO bands match on `above < wages <= upTo`; the top band is open-ended. */
function bandFor<B extends Band>(bands: readonly B[], wages: number): B {
  const band = bands.find((b) => b.above < wages && (b.upTo === null || wages <= b.upTo));
  // Unreachable for wages above 0: the generator checks the bands are contiguous from 0 up.
  /* v8 ignore next */
  if (band === undefined) throw new Error(`No band for ${wages} sen.`);
  return band;
}

function rowLabel(band: Band): string {
  if (band.upTo === null) return `Row ${band.no} (above ${formatRm(band.above)})`;
  if (band.above === 0) return `Row ${band.no} (up to ${formatRm(band.upTo)})`;
  return `Row ${band.no} (${formatRm(band.above + 1)} to ${formatRm(band.upTo)})`;
}

/** SOCSO, SKBBK and EIS contributions for one month, from the PERKESO tables in effect. */
export function calculateSocsoEis(
  input: SocsoEisInput,
  options: { now?: Date } = {},
): SocsoEisResult {
  const wages = monthlySalarySen(input.monthlySalary);
  const payPeriod = resolvePayPeriod(input.payPeriod, options.now);
  const skbbkStatus = input.skbbkStatus ?? "covered";
  const foreign = input.citizenship === "non_malaysian";
  if (foreign && skbbkStatus === "opted_out") {
    throw new PayrollInputError(
      "Foreign workers can't opt out of SKBBK: the opt-out is for local employees only. Use skbbkStatus covered.",
    );
  }
  const { age } = input;
  const eisAgeTest = age >= 57 && age < 60 && !foreign;
  if (eisAgeTest && input.eisPayableBefore57 === undefined) {
    throw new PayrollInputError(
      `eisPayableBefore57 is required for an employee aged ${age}: EIS stays payable from 57 only if contributions were payable before 57.`,
    );
  }

  // SOCSO (Act 4)
  const socsoTable = tableInEffect(socsoTableFor, payPeriod);
  const socsoBand = bandFor(socsoTable.bands, wages);
  const first = !foreign && age < 60;
  const socso = first
    ? {
        category: "first" as const,
        employee: socsoBand.cat1EmployeeInvalidity,
        employer: socsoBand.cat1Employer,
      }
    : { category: "second" as const, employee: 0, employer: socsoBand.cat2Employer };
  const socsoCitation: Citation = {
    item: "SOCSO",
    employee: toRm(socso.employee),
    employer: toRm(socso.employer),
    rule: first
      ? "First category (employment injury and invalidity): locals under 60. The employee's share is for invalidity."
      : `Second category (employment injury only): ${foreign ? "a foreign worker" : "aged 60 and over"}. The employer pays, the employee pays nothing to SOCSO.`,
    tableRow: `${rowLabel(socsoBand)}, ${socso.category} category`,
    source: socsoTable.source,
    effectiveFrom: socsoTable.effectiveFrom,
  };

  // SKBBK (Lindung 24 Jam): employee only, the same in both categories
  let skbbk = 0;
  let skbbkCitation: Citation;
  const skbbkTable = skbbkTableIfAny(payPeriod);
  if (skbbkTable.inEffect && skbbkStatus === "covered") {
    const band = bandFor(skbbkTable.table.bands, wages);
    skbbk = band.employee;
    skbbkCitation = {
      item: "SKBBK",
      employee: toRm(skbbk),
      employer: 0,
      rule: "SKBBK (Lindung 24 Jam) covers non-employment injury. The employee pays it alone, in both SOCSO categories.",
      tableRow: rowLabel(band),
      source: skbbkTable.table.source,
      effectiveFrom: skbbkTable.table.effectiveFrom,
    };
  } else {
    skbbkCitation = {
      item: "SKBBK",
      employee: 0,
      employer: 0,
      rule: skbbkTable.inEffect
        ? "The employee has opted out of SKBBK with PERKESO's approval, so nothing is deducted."
        : "SKBBK deductions start with June 2026 payroll, so nothing is due for this pay period.",
      source: skbbkTable.table.source,
      effectiveFrom: skbbkTable.table.effectiveFrom,
    };
  }

  // EIS (Act 800)
  const eisTable = tableInEffect(eisTableFor, payPeriod);
  const eisBand = bandFor(eisTable.bands, wages);
  let eisExemption: string | undefined;
  if (foreign) eisExemption = "Foreign workers are not covered by EIS.";
  else if (age < 18 || age >= 60) eisExemption = "EIS covers employees aged 18 to 59 only.";
  else if (eisAgeTest && input.eisPayableBefore57 === false) {
    eisExemption =
      "Act 800, First Schedule, paragraph 9: an employee aged 57 or over is exempt when no EIS contributions were payable before 57.";
  }
  const eis =
    eisExemption === undefined
      ? { covered: true, employee: eisBand.employee, employer: eisBand.employer }
      : { covered: false, employee: 0, employer: 0 };
  const eisCitation: Citation = {
    item: "EIS",
    employee: toRm(eis.employee),
    employer: toRm(eis.employer),
    ...(eisExemption === undefined
      ? {
          rule: "EIS: the employee and employer pay the same table amount.",
          tableRow: rowLabel(eisBand),
        }
      : { rule: eisExemption }),
    source: eisTable.source,
    effectiveFrom: eisTable.effectiveFrom,
  };

  const citations = [socsoCitation, skbbkCitation, eisCitation];
  return {
    payPeriod,
    monthlySalary: toRm(wages),
    skbbkStatus,
    socso: {
      category: socso.category,
      employee: toRm(socso.employee),
      employer: toRm(socso.employer),
    },
    skbbk: { employee: toRm(skbbk) },
    eis: { covered: eis.covered, employee: toRm(eis.employee), employer: toRm(eis.employer) },
    totals: {
      employee: toRm(socso.employee + skbbk + eis.employee),
      employer: toRm(socso.employer + eis.employer),
    },
    citations,
    explanation: renderExplanation(citations),
  };
}

/**
 * The SKBBK table in effect, or, before SKBBK started, the first one, so the zero line can still
 * cite where the scheme comes from.
 */
function skbbkTableIfAny(payPeriod: string): { inEffect: boolean; table: SkbbkTable } {
  try {
    return { inEffect: true, table: skbbkTableFor(payPeriod) };
  } catch (error) {
    /* v8 ignore next */
    if (!(error instanceof NoTableInEffectError) || error.earliest === undefined) throw error;
    return { inEffect: false, table: skbbkTableFor(error.earliest.slice(0, 7)) };
  }
}
