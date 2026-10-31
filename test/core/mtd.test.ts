import { describe, expect, it } from "vitest";
import { PayrollInputError } from "../../src/core/errors.js";
import { calculateMtd, type MtdInput } from "../../src/core/mtd.js";

const single: MtdInput = {
  monthlySalary: 5000,
  epfEmployee: 550,
  taxCategory: 1,
  payPeriod: "2026-01",
};

describe("calculateMtd", () => {
  it("cites the band, the formula and the LHDN schedule", () => {
    const result = calculateMtd(single);
    expect(result.citations).toEqual([
      expect.objectContaining({
        item: "MTD",
        employee: 110,
        employer: 0,
        tableRow: "Row 3 (P RM35,001 to RM50,000): M RM35,000.00, R 6%, B RM600.00",
        effectiveFrom: "2026-01-01",
      }),
    ]);
    expect(result.explanation).toContain("= RM47,000.07");
    expect(result.explanation).toContain("(RM1,320.00 − RM0.00) / 12");
    expect(result.yearToDate).toEqual({ remuneration: 0, epf: 0, mtd: 0, tp1Reliefs: 0 });
  });

  it("shows a negative B with a minus sign", () => {
    const result = calculateMtd({ ...single, monthlySalary: 4000, epfEmployee: 440 });
    expect(result.citations[0]?.tableRow).toContain("B −RM250.00");
  });

  it("deducts nothing when the formula gives less than RM10", () => {
    // P 30,200.07: tax for the year 56.00, so 4.66 a month, rounded to 4.70.
    const result = calculateMtd({ ...single, monthlySalary: 3600, epfEmployee: 396 });
    expect(result.working?.taxForYear).toBe(56);
    expect(result.mtd).toBe(0);
  });

  it("has no tax band when P is RM5,000 or less, even below zero", () => {
    const low = calculateMtd({ ...single, monthlySalary: 1000, epfEmployee: 110 });
    expect(low.working).toMatchObject({ chargeableIncome: 1680, taxForYear: 0 });
    expect(low.working?.taxBand).toBeUndefined();
    expect(low.mtd).toBe(0);
    expect(low.citations[0]?.tableRow).toBeUndefined();
    expect(low.explanation).toContain("below the first tax band");

    const negative = calculateMtd({ ...single, monthlySalary: 100, epfEmployee: 11 });
    expect(negative.working?.chargeableIncome).toBe(-7932);
    expect(negative.explanation).toContain("= −RM7,932.00");
  });

  it("caps EPF relief at RM4,000 in a single month, and reaches the open top band", () => {
    const result = calculateMtd({ ...single, monthlySalary: 200_000, epfEmployee: 22_000 });
    expect(result.working).toMatchObject({
      epfThisMonth: 4000,
      epfEachRemainingMonth: 0,
      chargeableIncome: 2_387_000,
      taxForYear: 644_500,
      taxBand: { above: 2_000_000, upTo: null, ratePercent: 30, b: 528_400 },
    });
    expect(result.mtd).toBe(53_708.35);
    expect(result.citations[0]?.tableRow).toContain("(P above RM2,000,000)");
  });

  it("takes the spouse relief and the category 2 B in category 2", () => {
    const cat2 = calculateMtd({ ...single, monthlySalary: 3000, epfEmployee: 330, taxCategory: 2 });
    const cat3 = calculateMtd({ ...single, monthlySalary: 3000, epfEmployee: 330, taxCategory: 3 });
    expect(Number(cat3.working?.chargeableIncome) - Number(cat2.working?.chargeableIncome)).toBe(
      4000,
    );
    expect(cat2.working?.taxBand?.b).toBe(-800);
    expect(cat3.working?.taxBand?.b).toBe(-250);
  });

  describe("same_salary_all_year", () => {
    it("works out every earlier month, matching MTD-05 by December", () => {
      const result = calculateMtd({
        ...single,
        yearToDate: "same_salary_all_year",
        payPeriod: "2026-12",
      });
      expect(result.yearToDate).toEqual({
        remuneration: 55_000,
        epf: 6050,
        mtd: 1210,
        tp1Reliefs: 0,
      });
      expect(result.mtd).toBe(110);
    });

    it("leaves out months whose MTD was under RM10", () => {
      const result = calculateMtd({
        ...single,
        monthlySalary: 3600,
        epfEmployee: 396,
        yearToDate: "same_salary_all_year",
        payPeriod: "2026-06",
      });
      expect(result.yearToDate?.mtd).toBe(0);
    });

    it("means no earlier months in January", () => {
      const result = calculateMtd({ ...single, yearToDate: "same_salary_all_year" });
      expect(result.yearToDate?.remuneration).toBe(0);
      expect(result.mtd).toBe(110);
    });
  });

  it("deducts nothing once the tax for the year is already paid", () => {
    const result = calculateMtd({
      ...single,
      yearToDate: { remuneration: 50_000, epf: 4000, mtd: 2000 },
      payPeriod: "2026-11",
    });
    expect(result.mtd).toBe(0);
  });

  describe("non-resident", () => {
    const nonResident: MtdInput = {
      monthlySalary: 3000,
      epfEmployee: 0,
      taxResident: false,
      payPeriod: "2026-11",
    };

    it("is a flat 30% with no working, year to date or tax category", () => {
      const result = calculateMtd({ ...nonResident, taxCategory: 2, children: 3 });
      expect(result).toMatchObject({
        mtd: 900,
        taxResident: false,
        taxCategory: null,
        children: 0,
      });
      expect(result).not.toHaveProperty("working");
      expect(result).not.toHaveProperty("yearToDate");
      expect(result.citations[0]?.rule).toContain("30% of RM3,000.00");
      expect(result.citations[0]).not.toHaveProperty("tableRow");
    });

    it.each([
      [1000.1, 300.05], // 300.03 rounds up to the next 5 sen
      [1000.03, 300], // 300.009 truncates to 300.00
      [33.33, 10], // 9.999 truncates to 9.99, which rounds up to 10.00, so it is deducted
      [33.1, 0], // 9.93 rounds up to 9.95, under RM10, so nothing is deducted
    ])("rounds %d to %d", (monthlySalary, mtd) => {
      expect(calculateMtd({ ...nonResident, monthlySalary }).mtd).toBe(mtd);
    });
  });

  it("defaults the pay period to the current month in Malaysia", () => {
    const { payPeriod: _, ...input } = single;
    const result = calculateMtd(input, { now: new Date("2026-01-15T00:00:00Z") });
    expect(result.payPeriod).toBe("2026-01");
  });

  it.each([
    [{ ...single, payPeriod: "2026-02" }, "yearToDate is required for pay period 2026-02"],
    [{ ...single, children: 1 }, "Category 1 (single) can't claim child relief"],
    [{ ...single, taxCategory: 3 as const, children: 1.5 }, "children must be a whole number"],
    [{ ...single, taxCategory: 3 as const, children: -1 }, "children must be a whole number"],
    [{ ...single, payPeriod: "2025-12" }, "No mtd rate table is in effect for pay period 2025-12"],
    [{ ...single, epfEmployee: 1.005 }, "at most 2 decimal places"],
    [{ ...single, monthlySalary: 0 }, "more than RM0"],
    [{ ...single, taxCategory: undefined }, "taxCategory is required for a resident employee"],
  ])("rejects %j", (input, message) => {
    expect(() => calculateMtd(input)).toThrow(PayrollInputError);
    expect(() => calculateMtd(input)).toThrow(message);
  });
});
