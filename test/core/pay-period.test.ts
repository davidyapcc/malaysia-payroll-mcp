import { describe, expect, it } from "vitest";
import { PayrollInputError } from "../../src/core/errors.js";
import { currentPayPeriod, resolvePayPeriod } from "../../src/core/pay-period.js";

describe("currentPayPeriod", () => {
  it("uses the month in Malaysia, not UTC", () => {
    // 31 Oct 2026, 16:30 UTC is already 1 Nov 2026, 00:30 in Kuala Lumpur (UTC+8).
    expect(currentPayPeriod(new Date("2026-10-31T16:30:00Z"))).toBe("2026-11");
    expect(currentPayPeriod(new Date("2026-10-31T15:59:59Z"))).toBe("2026-10");
  });
});

describe("resolvePayPeriod", () => {
  it("keeps a given pay period", () => {
    expect(resolvePayPeriod("2026-05", new Date("2026-11-15T00:00:00Z"))).toBe("2026-05");
  });

  it("defaults to the current month in Malaysia", () => {
    expect(resolvePayPeriod(undefined, new Date("2026-12-31T20:00:00Z"))).toBe("2027-01");
  });

  it("defaults to the real clock when no time is given", () => {
    expect(resolvePayPeriod(undefined)).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it.each(["2026-13", "2026-1", "2026-11-01", "", "Nov 2026"])("rejects %j", (payPeriod) => {
    expect(() => resolvePayPeriod(payPeriod)).toThrow(PayrollInputError);
  });
});
