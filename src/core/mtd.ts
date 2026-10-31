import { type MtdBand, type MtdTable, mtdTableFor } from "../tables/index.js";
import { type Citation, renderExplanation } from "./citation.js";
import { monthlySalarySen } from "./employee.js";
import { PayrollInputError, tableInEffect } from "./errors.js";
import { formatRm, toRm, toSen } from "./money.js";
import { resolvePayPeriod } from "./pay-period.js";

/**
 * LHDN's tax categories. 1: single. 2: married, spouse not working (or jointly assessed).
 * 3: married with a working spouse, divorced, widowed, or single with an adopted child.
 */
export type TaxCategory = 1 | 2 | 3;

/** What was paid and deducted earlier in the same calendar year, in RM. */
export interface MtdYearToDate {
  /** ∑Y: gross monthly salary paid in earlier months, including by a previous employer. */
  readonly remuneration: number;
  /** ∑K: the employee's EPF contributions on that salary, as paid. The RM4,000 cap is applied here. */
  readonly epf: number;
  /** X: MTD deducted in earlier months, including by a previous employer. */
  readonly mtd: number;
  /** ∑LP: other TP1 reliefs the employee claimed through payroll in earlier months. */
  readonly tp1Reliefs?: number | undefined;
}

export const SAME_SALARY_ALL_YEAR = "same_salary_all_year";

export interface MtdInput {
  /** Y1: RM, at most 2 decimal places (see CONTEXT.md). */
  readonly monthlySalary: number;
  /** K1 before the cap: the employee's EPF contribution this month, in RM (from calculate_epf). */
  readonly epfEmployee: number;
  /**
   * Defaults to true. False for an employee not resident, or not known to be resident, in Malaysia
   * (usually under 182 days in the year): a flat 30% with no reliefs (spec, Section D.a).
   */
  readonly taxResident?: boolean | undefined;
  /** Required for a resident. Ignored for a non-resident. */
  readonly taxCategory?: TaxCategory | undefined;
  /** C: qualifying children at RM2,000 each. Must be 0 in category 1. */
  readonly children?: number | undefined;
  /** LP1: other TP1 reliefs claimed through payroll this month, in RM. */
  readonly tp1Reliefs?: number | undefined;
  /**
   * Required from February. Either the year-to-date totals, or "same_salary_all_year" to assume
   * every earlier month this year had the same salary and EPF, no TP1 reliefs, and its MTD
   * deducted in full.
   */
  readonly yearToDate?: MtdYearToDate | typeof SAME_SALARY_ALL_YEAR | undefined;
  /** YYYY-MM. Defaults to the current month in Malaysia. */
  readonly payPeriod?: string | undefined;
}

export interface MtdResult {
  readonly payPeriod: string;
  readonly monthlySalary: number;
  readonly taxResident: boolean;
  /** null for a non-resident, who has no tax category. */
  readonly taxCategory: TaxCategory | null;
  readonly children: number;
  /** RM, deducted from pay. 0 when the formula gives less than RM10. */
  readonly mtd: number;
  /** The year-to-date figures used, after any same-salary assumption. RM. Residents only. */
  readonly yearToDate?: Required<MtdYearToDate>;
  /** The formula's working, in RM, so a payroll officer can check it line by line. Residents only. */
  readonly working?: {
    /** n: months left in the year after this one. */
    readonly monthsRemaining: number;
    /** K1 after the RM4,000 cap. */
    readonly epfThisMonth: number;
    /** K2: EPF relief estimated for each remaining month. */
    readonly epfEachRemainingMonth: number;
    /** P: chargeable income for the year. */
    readonly chargeableIncome: number;
    /** (P − M) × R + B, or 0 below the first band. */
    readonly taxForYear: number;
    /** The tax band picked on P floored to whole ringgit (ADR 0002), if P reaches one. */
    readonly taxBand?: {
      /** The band covers whole-ringgit P above this and up to and including `upTo`. */
      readonly above: number;
      readonly upTo: number | null;
      readonly m: number;
      readonly ratePercent: number;
      readonly b: number;
    };
  };
  readonly citations: readonly Citation[];
  readonly explanation: string;
}

/** Reliefs and limits from the spec the schedule was transcribed from, in sen. */
interface Reliefs {
  /** D */
  readonly individual: number;
  /** S, category 2 only */
  readonly spouse: number;
  /** Q, per child */
  readonly child: number;
  /** The annual cap on EPF relief (K + K1 + K2). */
  readonly epfCap: number;
}

/** LHDN PCB 2026 specification, Section E item 14. Keyed by the schedule's effective date. */
const RELIEFS: Readonly<Record<string, Reliefs>> = {
  "2026-01-01": { individual: 900_000, spouse: 400_000, child: 200_000, epfCap: 400_000 },
};

/** The reliefs that go with an MTD schedule. A new schedule needs its own entry here. */
export function reliefsFor(table: MtdTable): Reliefs {
  const reliefs = RELIEFS[table.effectiveFrom];
  // Unreachable while every schedule has an entry; test/tables checks that each one does.
  /* v8 ignore next */
  if (reliefs === undefined) throw new Error(`No reliefs for MTD ${table.effectiveFrom}.`);
  return reliefs;
}

/** No MTD is deducted when the formula gives less than this (spec, Section E item 3). */
const MINIMUM_SEN = 1_000;

/** The flat rate for a non-resident, in percent (spec, Section D.a). */
const NON_RESIDENT_RATE_PERCENT = 30;

/** Truncate to the sen, round up to the next 5 sen, and drop anything under RM10 (Section E). */
function roundMtd(sen: number): number {
  const rounded = Math.ceil(Math.floor(sen) / 5) * 5;
  return rounded < MINIMUM_SEN ? 0 : rounded;
}

interface Ytd {
  readonly remuneration: number;
  readonly epf: number;
  readonly mtd: number;
  readonly tp1Reliefs: number;
}

interface Month {
  readonly salary: number;
  readonly epf: number;
  readonly tp1Reliefs: number;
  readonly month: number;
  readonly category: TaxCategory;
  readonly children: number;
}

interface Computed {
  readonly mtd: number;
  readonly n: number;
  readonly k1: number;
  readonly k2: number;
  readonly p: number;
  readonly tax: number;
  readonly band: MtdBand | undefined;
}

/** The MTD formula for normal remuneration, in sen (spec, Section B). */
function compute(table: MtdTable, month: Month, ytd: Ytd): Computed {
  const reliefs = reliefsFor(table);
  const n = 12 - month.month;
  const k = Math.min(ytd.epf, reliefs.epfCap);
  const k1 = Math.min(month.epf, reliefs.epfCap - k);
  // K2 is the lower of K1 and the cap left over, spread over the remaining months; truncated.
  const k2 = n === 0 ? 0 : Math.min(k1, Math.floor((reliefs.epfCap - k - k1) / n));
  const deductions =
    reliefs.individual +
    (month.category === 2 ? reliefs.spouse : 0) +
    reliefs.child * month.children +
    ytd.tp1Reliefs +
    month.tp1Reliefs;
  const p = ytd.remuneration - k + (month.salary - k1) + (month.salary - k2) * n - deductions;

  // ADR 0002: the band (and with it the rebate in B) is picked on P floored to whole ringgit.
  const flooredP = Math.floor(p / 100) * 100;
  const band = table.bands.find(
    (b) => b.above < flooredP && (b.upTo === null || flooredP <= b.upTo),
  );
  if (band === undefined) return { mtd: 0, n, k1, k2, p, tax: 0, band };

  const b = month.category === 2 ? band.bCat2 : band.bCat1And3;
  const tax = Math.floor(((p - band.m) * band.ratePercent) / 100) + b;
  const owed = tax - ytd.mtd;
  if (owed <= 0) return { mtd: 0, n, k1, k2, p, tax, band };
  return { mtd: roundMtd(owed / (n + 1)), n, k1, k2, p, tax, band };
}

/** Earlier months under "same_salary_all_year": each one's MTD, worked out in turn. */
function sameSalaryYtd(table: MtdTable, month: Month): Ytd {
  let ytd: Ytd = { remuneration: 0, epf: 0, mtd: 0, tp1Reliefs: 0 };
  for (let m = 1; m < month.month; m++) {
    const earlier = compute(table, { ...month, month: m, tp1Reliefs: 0 }, ytd);
    ytd = {
      remuneration: ytd.remuneration + month.salary,
      epf: ytd.epf + month.epf,
      mtd: ytd.mtd + earlier.mtd,
      tp1Reliefs: 0,
    };
  }
  return ytd;
}

const CATEGORY: Readonly<Record<TaxCategory, string>> = {
  1: "Category 1 (single): individual relief only.",
  2: "Category 2 (married, spouse not working): individual and spouse reliefs, and B includes the spouse rebate.",
  3: "Category 3 (married with a working spouse, divorced, widowed, or single with an adopted child): individual relief, no spouse relief.",
};

/** MTD (PCB) for one month, for a resident employee, from LHDN's schedule in effect. */
export function calculateMtd(input: MtdInput, options: { now?: Date } = {}): MtdResult {
  const salary = monthlySalarySen(input.monthlySalary);
  const epf = toSen(input.epfEmployee);
  const tp1Reliefs = toSen(input.tp1Reliefs ?? 0);
  const payPeriod = resolvePayPeriod(input.payPeriod, options.now);
  const table = tableInEffect(mtdTableFor, payPeriod);
  if (input.taxResident === false) return nonResident(salary, payPeriod, table);
  const month = Number(payPeriod.slice(5));
  const children = input.children ?? 0;
  const category = input.taxCategory;
  if (category === undefined) {
    throw new PayrollInputError(
      "taxCategory is required for a resident employee: 1 single, 2 married with a non-working spouse, 3 otherwise. For a non-resident, set taxResident to false.",
    );
  }
  if (!Number.isInteger(children) || children < 0) {
    throw new PayrollInputError(`children must be a whole number of 0 or more, got ${children}.`);
  }
  if (category === 1 && children > 0) {
    throw new PayrollInputError(
      "Category 1 (single) can't claim child relief. Use taxCategory 3 for a divorced or widowed parent, or a single parent of an adopted child.",
    );
  }

  const m: Month = { salary, epf, tp1Reliefs, month, category, children };
  let ytd: Ytd;
  if (input.yearToDate === SAME_SALARY_ALL_YEAR) ytd = sameSalaryYtd(table, m);
  else if (input.yearToDate !== undefined) {
    ytd = {
      remuneration: toSen(input.yearToDate.remuneration),
      epf: toSen(input.yearToDate.epf),
      mtd: toSen(input.yearToDate.mtd),
      tp1Reliefs: toSen(input.yearToDate.tp1Reliefs ?? 0),
    };
  } else if (month === 1) ytd = { remuneration: 0, epf: 0, mtd: 0, tp1Reliefs: 0 };
  else {
    throw new PayrollInputError(
      `yearToDate is required for pay period ${payPeriod}: give the salary, EPF and MTD from earlier months this year (all 0 if the employee had no earlier income this year), or "${SAME_SALARY_ALL_YEAR}".`,
    );
  }

  const c = compute(table, m, ytd);
  const { band } = c;
  const b = band === undefined ? 0 : category === 2 ? band.bCat2 : band.bCat1And3;
  const rule = [
    CATEGORY[category],
    `P = (∑Y − ∑K) + (Y1 − K1) + (Y2 − K2) × n − reliefs = ${signedRm(c.p)}, with EPF relief capped at RM4,000 for the year.`,
    band === undefined
      ? "P is RM5,000 or less, below the first tax band, so there is no MTD."
      : `MTD = [(P − M) × R + B − X] / (n + 1) = (${signedRm(c.tax)} − ${formatRm(ytd.mtd)}) / ${c.n + 1}, with the band picked on P floored to whole ringgit (ADR 0002), truncated to the sen and rounded up to the next 5 sen. Under RM10, nothing is deducted.`,
  ].join(" ");
  const citation: Citation = {
    item: "MTD",
    employee: toRm(c.mtd),
    employer: 0,
    rule,
    ...(band === undefined
      ? {}
      : {
          tableRow: `Row ${band.no} (P ${bandRange(band)}): M ${formatRm(band.m)}, R ${band.ratePercent}%, B ${signedRm(b)}`,
        }),
    source: table.source,
    effectiveFrom: table.effectiveFrom,
  };
  const citations = [citation];
  return {
    payPeriod,
    monthlySalary: toRm(salary),
    taxResident: true,
    taxCategory: category,
    children,
    mtd: toRm(c.mtd),
    yearToDate: {
      remuneration: toRm(ytd.remuneration),
      epf: toRm(ytd.epf),
      mtd: toRm(ytd.mtd),
      tp1Reliefs: toRm(ytd.tp1Reliefs),
    },
    working: {
      monthsRemaining: c.n,
      epfThisMonth: toRm(c.k1),
      epfEachRemainingMonth: toRm(c.k2),
      chargeableIncome: toRm(c.p),
      taxForYear: toRm(c.tax),
      ...(band === undefined
        ? {}
        : {
            taxBand: {
              above: toRm(band.above),
              upTo: band.upTo === null ? null : toRm(band.upTo),
              m: toRm(band.m),
              ratePercent: band.ratePercent,
              b: toRm(b),
            },
          }),
    },
    citations,
    explanation: renderExplanation(citations),
  };
}

/**
 * A non-resident pays a flat 30% of the month's remuneration, with no reliefs, rebates or EPF
 * relief, and no year-to-date working. Section E's rounding still applies.
 */
function nonResident(salary: number, payPeriod: string, table: MtdTable): MtdResult {
  const mtd = roundMtd((salary * NON_RESIDENT_RATE_PERCENT) / 100);
  const citation: Citation = {
    item: "MTD",
    employee: toRm(mtd),
    employer: 0,
    rule: `Non-resident (not resident, or not known to be resident, in Malaysia): a flat ${NON_RESIDENT_RATE_PERCENT}% of the remuneration, with no reliefs or rebates (Section D.a): ${NON_RESIDENT_RATE_PERCENT}% of ${formatRm(salary)}, truncated to the sen and rounded up to the next 5 sen. Under RM10, nothing is deducted.`,
    source: table.source,
    effectiveFrom: table.effectiveFrom,
  };
  const citations = [citation];
  return {
    payPeriod,
    monthlySalary: toRm(salary),
    taxResident: false,
    taxCategory: null,
    children: 0,
    mtd: toRm(mtd),
    citations,
    explanation: renderExplanation(citations),
  };
}

/** As the spec prints it, in whole ringgit: "RM35,001 to RM50,000". */
function bandRange(band: MtdBand): string {
  const ringgit = (sen: number) => formatRm(sen).slice(0, -3);
  if (band.upTo === null) return `above ${ringgit(band.above)}`;
  return `${ringgit(band.above + 100)} to ${ringgit(band.upTo)}`;
}

function signedRm(sen: number): string {
  return sen < 0 ? `−${formatRm(-sen)}` : formatRm(sen);
}
