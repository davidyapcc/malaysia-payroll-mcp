import { describe, expect, it } from "vitest";
import { NoTableInEffectError, type RateTableMeta, selectTable } from "../../src/tables/loader.js";

function table(effectiveFrom: string): RateTableMeta {
  return {
    kind: "test",
    effectiveFrom,
    csv: `docs/data/test-from-${effectiveFrom}.csv`,
    source: { title: "Test", url: "https://example.com", retrieved: "2026-10-23" },
  };
}

describe("selectTable", () => {
  // Deliberately out of order: the loader must not rely on the generated order.
  const tables = [table("2028-06-01"), table("2024-10-01"), table("2026-06-01")];

  it("picks the newest table in effect for the pay period", () => {
    expect(selectTable("test", tables, "2026-11").effectiveFrom).toBe("2026-06-01");
    expect(selectTable("test", tables, "2031-01").effectiveFrom).toBe("2028-06-01");
  });

  it("applies a table from the month of its effective date", () => {
    expect(selectTable("test", tables, "2026-05").effectiveFrom).toBe("2024-10-01");
    expect(selectTable("test", tables, "2026-06").effectiveFrom).toBe("2026-06-01");
    expect(selectTable("test", tables, "2024-10").effectiveFrom).toBe("2024-10-01");
  });

  it("rejects a pay period before the earliest table", () => {
    const error = (() => {
      try {
        selectTable("test", tables, "2024-09");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NoTableInEffectError);
    expect(error).toMatchObject({ kind: "test", payPeriod: "2024-09", earliest: "2024-10-01" });
    expect((error as Error).message).toBe(
      "No test rate table is in effect for pay period 2024-09; the earliest starts 2024-10-01.",
    );
  });

  it("says so when there are no tables at all", () => {
    expect(() => selectTable("test", [], "2026-11")).toThrow("No test rate table exists.");
  });

  it.each(["2026-13", "2026-1", "2026-11-01", "", "Nov 2026"])(
    "rejects the malformed pay period %j",
    (payPeriod) => {
      expect(() => selectTable("test", tables, payPeriod)).toThrow(RangeError);
    },
  );
});
