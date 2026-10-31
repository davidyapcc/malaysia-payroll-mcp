import { describe, expect, it } from "vitest";
import { calculateEpf } from "../../src/core/epf.js";
import { PayrollInputError } from "../../src/core/errors.js";
import { calculateMtd } from "../../src/core/mtd.js";
import { calculateNetPay, type NetPayInput } from "../../src/core/net-pay.js";
import { calculateSocsoEis } from "../../src/core/socso-eis.js";

const employee: NetPayInput = {
  monthlySalary: 5000,
  age: 30,
  citizenship: "malaysian",
  taxCategory: 1,
  yearToDate: "same_salary_all_year",
  payPeriod: "2026-11",
};

describe("calculateNetPay", () => {
  it("agrees line by line with the three calculators, feeding the EPF employee share into MTD", () => {
    const input = { ...employee, monthlySalary: 7321.45, taxCategory: 2, children: 2 } as const;
    const result = calculateNetPay(input);
    const epf = calculateEpf(input);
    const socsoEis = calculateSocsoEis(input);
    const mtd = calculateMtd({ ...input, epfEmployee: epf.employee });
    expect(result.deductions).toMatchObject({
      epf: epf.employee,
      socso: socsoEis.socso.employee,
      skbbk: socsoEis.skbbk.employee,
      eis: socsoEis.eis.employee,
      mtd: mtd.mtd,
    });
    expect(result.citations).toEqual([...epf.citations, ...socsoEis.citations, ...mtd.citations]);
    expect(result.basis).toEqual({
      epfPart: "A",
      socsoCategory: "first",
      skbbkStatus: "covered",
      eisCovered: true,
      taxCategory: 2,
      children: 2,
      mtdYearToDate: mtd.yearToDate,
    });
  });

  it("adds up in sen, so the totals have no float drift", () => {
    const result = calculateNetPay({ ...employee, monthlySalary: 3333.33 });
    const { deductions: d, employerContributions: e } = result;
    const sen = (rm: number) => Math.round(rm * 100);
    expect(sen(d.total)).toBe(sen(d.epf) + sen(d.socso) + sen(d.skbbk) + sen(d.eis) + sen(d.mtd));
    expect(sen(result.netPay)).toBe(333_333 - sen(d.total));
    expect(sen(e.total)).toBe(sen(e.epf) + sen(e.socso) + sen(e.eis));
    expect(sen(result.employerCost)).toBe(333_333 + sen(e.total));
    for (const amount of [d.total, result.netPay, e.total, result.employerCost]) {
      expect(sen(amount) / 100).toBe(amount);
    }
  });

  it("ends the explanation with the net pay and employer cost", () => {
    const lines = calculateNetPay(employee).explanation.split("\n");
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "EPF",
      "SOCSO",
      "SKBBK",
      "EIS",
      "MTD",
      "Net pay",
    ]);
    expect(lines.at(-1)).toBe(
      "Net pay: RM5,000.00 − RM731.80 in statutory deductions = RM4,268.20. Employer cost: RM5,000.00 + RM746.55 in employer contributions = RM5,746.55.",
    );
  });

  it("uses one pay period for every line when it defaults", () => {
    const now = new Date("2026-01-31T16:30:00Z"); // 1 Feb 00:30 in Malaysia
    const { payPeriod: _, yearToDate: __, ...input } = employee;
    const result = calculateNetPay({ ...input, yearToDate: "same_salary_all_year" }, { now });
    expect(result.payPeriod).toBe("2026-02");
    expect(result.basis.mtdYearToDate.remuneration).toBe(5000);
  });

  it("passes on an input error from any calculation", () => {
    expect(() => calculateNetPay({ ...employee, monthlySalary: 0 })).toThrow(PayrollInputError);
    expect(() => calculateNetPay({ ...employee, payPeriod: "2026-13" })).toThrow(
      'Pay period must be YYYY-MM, got "2026-13".',
    );
    expect(() =>
      calculateNetPay({ ...employee, citizenship: "non_malaysian", skbbkStatus: "opted_out" }),
    ).toThrow("Foreign workers can't opt out of SKBBK");
    expect(() => calculateNetPay({ ...employee, yearToDate: undefined })).toThrow(
      "yearToDate is required for pay period 2026-11",
    );
  });
});
