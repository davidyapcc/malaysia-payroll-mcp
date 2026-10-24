import { describe, expect, it } from "vitest";
import { PayrollInputError } from "../../src/core/errors.js";
import { ceilPerMilleToRinggit, formatRm, toRm, toSen } from "../../src/core/money.js";

describe("toSen", () => {
  it.each([
    [3000, 300_000],
    [5000.01, 500_001],
    [25000.5, 2_500_050],
    [0.1 + 0.2, 30],
  ])("converts RM%d to %d sen", (rm, sen) => {
    expect(toSen(rm)).toBe(sen);
  });

  it.each([1.234, 1.005, Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects %d", (rm) => {
    expect(() => toSen(rm)).toThrow(PayrollInputError);
  });
});

describe("toRm", () => {
  it("converts sen back to RM", () => {
    expect(toRm(5165)).toBe(51.65);
    expect(toRm(0)).toBe(0);
  });
});

describe("formatRm", () => {
  it.each([
    [0, "RM0.00"],
    [5, "RM0.05"],
    [298_001, "RM2,980.01"],
    [2_000_000, "RM20,000.00"],
    [123_456_789, "RM1,234,567.89"],
  ])("formats %d sen as %s", (sen, text) => {
    expect(formatRm(sen)).toBe(text);
  });
});

describe("ceilPerMilleToRinggit", () => {
  it("rounds a share with cents up to the next ringgit", () => {
    expect(ceilPerMilleToRinggit(2_500_050, 120)).toBe(300_100);
    expect(ceilPerMilleToRinggit(2_500_050, 110)).toBe(275_100);
  });

  it("leaves a whole-ringgit share alone", () => {
    expect(ceilPerMilleToRinggit(2_500_000, 120)).toBe(300_000);
    expect(ceilPerMilleToRinggit(2_500_000, 0)).toBe(0);
  });
});
