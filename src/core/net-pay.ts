import { type Citation, renderExplanation } from "./citation.js";
import { type Citizenship, monthlySalarySen } from "./employee.js";
import { calculateEpf, type EpfResult } from "./epf.js";
import { PayrollInputError } from "./errors.js";
import { formatRm, toRm, toSen } from "./money.js";
import { calculateMtd, type MtdInput, type MtdResult, type TaxCategory } from "./mtd.js";
import { calculateSocsoEis, type SkbbkStatus, type SocsoEisResult } from "./socso-eis.js";

export interface NetPayInput {
  /** RM, at most 2 decimal places (see CONTEXT.md). */
  readonly monthlySalary: number;
  readonly age: number;
  readonly citizenship: Citizenship;
  /** EPF: only matters for non-Malaysians. */
  readonly registeredWithEpfBefore1Aug1998?: boolean | undefined;
  /** SOCSO: defaults to covered. */
  readonly skbbkStatus?: SkbbkStatus | undefined;
  /** EIS: required from 57 to 59. */
  readonly eisPayableBefore57?: boolean | undefined;
  /** MTD: defaults to true, except that a non-Malaysian has to say. */
  readonly taxResident?: boolean | undefined;
  /** MTD: required for a tax resident. */
  readonly taxCategory?: TaxCategory | undefined;
  readonly children?: number | undefined;
  readonly tp1Reliefs?: number | undefined;
  /** MTD: required from February. "same_salary_all_year" reuses this month's salary and EPF. */
  readonly yearToDate?: MtdInput["yearToDate"];
  /** YYYY-MM. Defaults to the current month in Malaysia. */
  readonly payPeriod?: string | undefined;
}

export interface NetPayResult {
  readonly payPeriod: string;
  readonly monthlySalary: number;
  /** What comes off the employee's pay, in RM. */
  readonly deductions: {
    readonly epf: number;
    readonly socso: number;
    readonly skbbk: number;
    readonly eis: number;
    readonly mtd: number;
    readonly total: number;
  };
  /** RM: monthly salary minus every statutory deduction. */
  readonly netPay: number;
  /** What the employer pays on top of the salary, in RM. */
  readonly employerContributions: {
    readonly epf: number;
    readonly socso: number;
    readonly eis: number;
    readonly total: number;
  };
  /** RM: monthly salary plus the employer's contributions. */
  readonly employerCost: number;
  /** The rules each calculator picked, so the payslip can be checked against the tools. */
  readonly basis: {
    readonly epfPart: EpfResult["part"];
    readonly socsoCategory: SocsoEisResult["socso"]["category"];
    readonly skbbkStatus: SkbbkStatus;
    readonly eisCovered: boolean;
    readonly taxResident: boolean;
    readonly taxCategory: TaxCategory | null;
    readonly children: number;
    /** Residents only. */
    readonly mtdYearToDate?: MtdResult["yearToDate"];
  };
  readonly citations: readonly Citation[];
  readonly explanation: string;
}

/**
 * One month's payslip: runs the EPF, SOCSO/SKBBK/EIS and MTD calculators in turn (MTD takes the
 * employee EPF share), and adds up the deductions in sen.
 */
export function calculateNetPay(input: NetPayInput, options: { now?: Date } = {}): NetPayResult {
  const salary = monthlySalarySen(input.monthlySalary);
  // A foreign worker's tax residence varies (182 days in the year), so it is never assumed.
  if (input.citizenship === "non_malaysian" && input.taxResident === undefined) {
    throw new PayrollInputError(
      "taxResident is required for a non_malaysian employee: true if they are tax resident in Malaysia (usually 182 days or more in the calendar year), false for the flat 30% non-resident rate.",
    );
  }
  const common = {
    monthlySalary: input.monthlySalary,
    age: input.age,
    citizenship: input.citizenship,
    payPeriod: input.payPeriod,
  };
  const epf = calculateEpf(
    { ...common, registeredWithEpfBefore1Aug1998: input.registeredWithEpfBefore1Aug1998 },
    options,
  );
  // Every calculator gets the pay period the first one resolved, so a month boundary can't split them.
  const payPeriod = epf.payPeriod;
  const socsoEis = calculateSocsoEis(
    {
      ...common,
      payPeriod,
      skbbkStatus: input.skbbkStatus,
      eisPayableBefore57: input.eisPayableBefore57,
    },
    options,
  );
  const mtd = calculateMtd(
    {
      monthlySalary: input.monthlySalary,
      epfEmployee: epf.employee,
      taxResident: input.taxResident,
      taxCategory: input.taxCategory,
      children: input.children,
      tp1Reliefs: input.tp1Reliefs,
      yearToDate: input.yearToDate,
      payPeriod,
    },
    options,
  );

  const d = {
    epf: toSen(epf.employee),
    socso: toSen(socsoEis.socso.employee),
    skbbk: toSen(socsoEis.skbbk.employee),
    eis: toSen(socsoEis.eis.employee),
    mtd: toSen(mtd.mtd),
  };
  const deducted = d.epf + d.socso + d.skbbk + d.eis + d.mtd;
  const e = {
    epf: toSen(epf.employer),
    socso: toSen(socsoEis.socso.employer),
    eis: toSen(socsoEis.eis.employer),
  };
  const employerTotal = e.epf + e.socso + e.eis;
  const net = salary - deducted;

  const citations = [...epf.citations, ...socsoEis.citations, ...mtd.citations];
  const summary =
    `Net pay: ${formatRm(salary)} − ${formatRm(deducted)} in statutory deductions = ${formatRm(net)}. ` +
    `Employer cost: ${formatRm(salary)} + ${formatRm(employerTotal)} in employer contributions = ${formatRm(salary + employerTotal)}.`;
  return {
    payPeriod,
    monthlySalary: toRm(salary),
    deductions: {
      epf: toRm(d.epf),
      socso: toRm(d.socso),
      skbbk: toRm(d.skbbk),
      eis: toRm(d.eis),
      mtd: toRm(d.mtd),
      total: toRm(deducted),
    },
    netPay: toRm(net),
    employerContributions: {
      epf: toRm(e.epf),
      socso: toRm(e.socso),
      eis: toRm(e.eis),
      total: toRm(employerTotal),
    },
    employerCost: toRm(salary + employerTotal),
    basis: {
      epfPart: epf.part,
      socsoCategory: socsoEis.socso.category,
      skbbkStatus: socsoEis.skbbkStatus,
      eisCovered: socsoEis.eis.covered,
      taxResident: mtd.taxResident,
      taxCategory: mtd.taxCategory,
      children: mtd.children,
      ...(mtd.yearToDate === undefined ? {} : { mtdYearToDate: mtd.yearToDate }),
    },
    citations,
    explanation: `${renderExplanation(citations)}\n${summary}`,
  };
}
