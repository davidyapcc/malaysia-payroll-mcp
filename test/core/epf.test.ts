import { describe, expect, it } from "vitest";
import { calculateEpf } from "../../src/core/epf.js";
import { PayrollInputError } from "../../src/core/errors.js";

const base = { monthlySalary: 3000, age: 30, payPeriod: "2026-11" } as const;

describe("calculateEpf", () => {
  it("cites the band, the schedule and its effective date", () => {
    const result = calculateEpf({ ...base, citizenship: "malaysian" });
    expect(result).toMatchObject({ payPeriod: "2026-11", monthlySalary: 3000, part: "A" });
    expect(result.citations).toEqual([
      {
        item: "EPF",
        employee: 330,
        employer: 390,
        rule: expect.stringContaining("Part A"),
        tableRow: "Part A, RM2,980.01 to RM3,000.00",
        source: {
          title: "EPF Act 1991, Third Schedule (from 1 October 2025)",
          url: "https://www.kwsp.gov.my/documents/d/guest/third_schedule_from_-1-october-2025",
          retrieved: "2026-10-23",
        },
        effectiveFrom: "2025-10-01",
      },
    ]);
    expect(result.explanation).toContain("EPF: employee RM330.00, employer RM390.00.");
    expect(result.explanation).toContain("Part A, RM2,980.01 to RM3,000.00");
  });

  it("uses the bottom band's nil amounts", () => {
    const result = calculateEpf({ ...base, monthlySalary: 0.01, citizenship: "malaysian" });
    expect(result.citations[0]?.tableRow).toBe("Part A, RM0.01 to RM10.00");
    expect(result).toMatchObject({ employee: 0, employer: 0 });
  });

  describe("part", () => {
    it("uses Part A for a permanent resident under 60", () => {
      expect(calculateEpf({ ...base, citizenship: "permanent_resident" })).toMatchObject({
        part: "A",
        employer: 390,
        employee: 330,
      });
    });

    it("uses Part A and C for a non-Malaysian registered before 1 Aug 1998", () => {
      const input = {
        ...base,
        citizenship: "non_malaysian" as const,
        registeredWithEpfBefore1Aug1998: true,
      };
      expect(calculateEpf({ ...input, age: 30 })).toMatchObject({ part: "A" });
      expect(calculateEpf({ ...input, age: 60 })).toMatchObject({ part: "C" });
    });

    it("uses Part F for a non-Malaysian registered from 1 Aug 1998, at any age", () => {
      for (const age of [30, 65]) {
        expect(calculateEpf({ ...base, age, citizenship: "non_malaysian" })).toMatchObject({
          part: "F",
          employer: 60,
          employee: 60,
        });
      }
      expect(
        calculateEpf({
          ...base,
          citizenship: "non_malaysian",
          registeredWithEpfBefore1Aug1998: false,
        }),
      ).toMatchObject({ part: "F" });
    });

    it("switches to Part E for a Malaysian at 60, not 59", () => {
      expect(calculateEpf({ ...base, age: 59, citizenship: "malaysian" })).toMatchObject({
        part: "A",
      });
      expect(calculateEpf({ ...base, age: 60, citizenship: "malaysian" })).toMatchObject({
        part: "E",
        employer: 120,
        employee: 0,
      });
    });
  });

  describe("above RM20,000", () => {
    it("uses the table up to and including RM20,000", () => {
      const result = calculateEpf({ ...base, monthlySalary: 20000, citizenship: "malaysian" });
      expect(result).toMatchObject({ employer: 2400, employee: 2200 });
      expect(result.citations[0]?.tableRow).toBe("Part A, RM19,900.01 to RM20,000.00");
    });

    it("switches to percentages one sen above, each share rounded up", () => {
      const result = calculateEpf({ ...base, monthlySalary: 20000.01, citizenship: "malaysian" });
      expect(result).toMatchObject({ employer: 2401, employee: 2201, total: 4602 });
      expect(result.citations[0]).not.toHaveProperty("tableRow");
      expect(result.citations[0]?.rule).toContain("12%");
    });

    it.each([
      ["permanent_resident", 62, "C", 1800, 1650],
      ["malaysian", 62, "E", 1200, 0],
    ] as const)("applies %s age %d (Part %s) percentages", (citizenship, age, part, er, ee) => {
      expect(calculateEpf({ ...base, monthlySalary: 30000, age, citizenship })).toMatchObject({
        part,
        employer: er,
        employee: ee,
      });
    });
  });

  it("rounds each Part F share up separately", () => {
    expect(
      calculateEpf({ ...base, monthlySalary: 3500.5, citizenship: "non_malaysian" }),
    ).toMatchObject({ employer: 71, employee: 71, total: 142 });
  });

  it("defaults the pay period to the current month in Malaysia", () => {
    const { payPeriod, ...input } = { ...base, citizenship: "malaysian" as const };
    const result = calculateEpf(input, { now: new Date("2026-10-31T16:30:00Z") });
    expect(result.payPeriod).toBe("2026-11");
  });

  it("rejects a pay period before the earliest schedule", () => {
    expect(() => calculateEpf({ ...base, payPeriod: "2025-09", citizenship: "malaysian" })).toThrow(
      new PayrollInputError(
        "No epf rate table is in effect for pay period 2025-09; the earliest starts 2025-10-01.",
      ),
    );
  });

  it("rejects a salary with more than 2 decimal places", () => {
    expect(() =>
      calculateEpf({ ...base, monthlySalary: 3000.001, citizenship: "malaysian" }),
    ).toThrow(PayrollInputError);
  });
});

describe("calculateEpf salary", () => {
  it("rejects RM0", () => {
    expect(() =>
      calculateEpf({ monthlySalary: 0, age: 30, citizenship: "malaysian", payPeriod: "2026-11" }),
    ).toThrow(new PayrollInputError("Monthly salary must be more than RM0."));
  });
});
