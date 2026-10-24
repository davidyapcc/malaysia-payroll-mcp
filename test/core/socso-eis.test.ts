import { describe, expect, it } from "vitest";
import { PayrollInputError } from "../../src/core/errors.js";
import { calculateSocsoEis } from "../../src/core/socso-eis.js";

const base = {
  monthlySalary: 3000,
  age: 30,
  citizenship: "malaysian",
  payPeriod: "2026-11",
} as const;

describe("calculateSocsoEis", () => {
  it("cites one table row per line, SKBBK on its own", () => {
    const result = calculateSocsoEis(base);
    expect(result).toMatchObject({
      payPeriod: "2026-11",
      monthlySalary: 3000,
      skbbkStatus: "covered",
      totals: { employee: 42.8, employer: 57.55 },
    });
    expect(result.citations.map((c) => [c.item, c.tableRow, c.effectiveFrom])).toEqual([
      ["SOCSO", "Row 34 (RM2,900.01 to RM3,000.00), first category", "2024-10-01"],
      ["SKBBK", "Row 34 (RM2,900.01 to RM3,000.00)", "2026-06-01"],
      ["EIS", "Row 34 (RM2,900.01 to RM3,000.00)", "2024-10-01"],
    ]);
    expect(result.citations[1]).toMatchObject({ employee: 22.15, employer: 0 });
    expect(result.explanation.split("\n")).toHaveLength(3);
    expect(result.explanation).toContain("SKBBK: employee RM22.15, employer RM0.00.");
  });

  it("names the open-ended top band and the bottom band", () => {
    const top = calculateSocsoEis({ ...base, monthlySalary: 6000.01 });
    expect(top.citations[0]?.tableRow).toBe("Row 65 (above RM6,000.00), first category");
    const bottom = calculateSocsoEis({ ...base, monthlySalary: 30 });
    expect(bottom.citations[2]?.tableRow).toBe("Row 1 (up to RM30.00)");
    expect(bottom.eis).toEqual({ covered: true, employee: 0.05, employer: 0.05 });
  });

  describe("SOCSO category", () => {
    it("puts a permanent resident under 60 in the first category", () => {
      expect(calculateSocsoEis({ ...base, citizenship: "permanent_resident" }).socso).toEqual({
        category: "first",
        employee: 14.75,
        employer: 51.65,
      });
    });

    it("puts a foreign worker in the second category, still paying SKBBK", () => {
      const result = calculateSocsoEis({ ...base, citizenship: "non_malaysian" });
      expect(result.socso).toEqual({ category: "second", employee: 0, employer: 36.9 });
      expect(result.skbbk).toEqual({ employee: 22.15 });
      expect(result.citations[0]?.rule).toContain("foreign worker");
    });

    it("moves to the second category at 60", () => {
      expect(calculateSocsoEis({ ...base, age: 59, eisPayableBefore57: true }).socso.category).toBe(
        "first",
      );
      expect(calculateSocsoEis({ ...base, age: 60 }).socso.category).toBe("second");
    });
  });

  describe("SKBBK", () => {
    it("defaults to covered", () => {
      expect(calculateSocsoEis(base).skbbkStatus).toBe("covered");
    });

    it("explains an opt-out", () => {
      const result = calculateSocsoEis({ ...base, skbbkStatus: "opted_out" });
      expect(result.skbbkStatus).toBe("opted_out");
      expect(result.citations[1]).toMatchObject({ item: "SKBBK", employee: 0 });
      expect(result.citations[1]?.rule).toContain("opted out");
      expect(result.citations[1]).not.toHaveProperty("tableRow");
    });

    it("explains that nothing is due before June 2026, citing the SKBBK table", () => {
      const result = calculateSocsoEis({ ...base, payPeriod: "2026-05" });
      expect(result.citations[1]).toMatchObject({
        item: "SKBBK",
        employee: 0,
        effectiveFrom: "2026-06-01",
      });
      expect(result.citations[1]?.rule).toContain("June 2026");
      expect(calculateSocsoEis({ ...base, payPeriod: "2026-06" }).skbbk.employee).toBe(22.15);
    });
  });

  describe("EIS coverage", () => {
    it.each([
      [17, false],
      [18, true],
      [56, true],
      [60, false],
    ])("at age %d covered is %s", (age, covered) => {
      expect(calculateSocsoEis({ ...base, age }).eis.covered).toBe(covered);
    });

    it("covers a permanent resident and exempts a foreign worker", () => {
      expect(calculateSocsoEis({ ...base, citizenship: "permanent_resident" }).eis.covered).toBe(
        true,
      );
      const foreign = calculateSocsoEis({ ...base, citizenship: "non_malaysian" });
      expect(foreign.eis).toEqual({ covered: false, employee: 0, employer: 0 });
      expect(foreign.citations[2]?.rule).toContain("Foreign workers");
    });

    it("needs eisPayableBefore57 from 57 to 59", () => {
      for (const age of [57, 59]) {
        expect(() => calculateSocsoEis({ ...base, age })).toThrow(
          new PayrollInputError(
            `eisPayableBefore57 is required for an employee aged ${age}: EIS stays payable from 57 only if contributions were payable before 57.`,
          ),
        );
      }
    });

    it("ignores eisPayableBefore57 under 57", () => {
      expect(calculateSocsoEis({ ...base, eisPayableBefore57: false }).eis.covered).toBe(true);
    });

    it("cites paragraph 9 when the age exemption applies", () => {
      const result = calculateSocsoEis({ ...base, age: 58, eisPayableBefore57: false });
      expect(result.citations[2]?.rule).toContain("First Schedule, paragraph 9");
    });
  });

  it("defaults the pay period to the current month in Malaysia", () => {
    const { payPeriod, ...input } = base;
    expect(calculateSocsoEis(input, { now: new Date("2026-10-31T16:30:00Z") }).payPeriod).toBe(
      "2026-11",
    );
  });

  it("rejects a pay period before the SOCSO and EIS tables", () => {
    expect(() => calculateSocsoEis({ ...base, payPeriod: "2024-09" })).toThrow(PayrollInputError);
  });
});

describe("calculateSocsoEis salary", () => {
  it("rejects RM0", () => {
    expect(() => calculateSocsoEis({ ...base, monthlySalary: 0 })).toThrow(PayrollInputError);
  });
});
