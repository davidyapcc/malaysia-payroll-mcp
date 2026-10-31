// Runs every golden case through the core. The cases are the source of truth (test/golden/);
// docs/golden-cases.md explains each one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateEpf, type EpfInput } from "../src/core/epf.js";
import { PayrollInputError } from "../src/core/errors.js";
import { calculateMtd, type MtdInput } from "../src/core/mtd.js";
import { calculateNetPay, type NetPayInput } from "../src/core/net-pay.js";
import { calculateSocsoEis, type SocsoEisInput } from "../src/core/socso-eis.js";
import golden from "./golden/cases.json" with { type: "json" };

interface GoldenCase<I> {
  id: string;
  input: I;
  expected?: Record<string, unknown>;
  error?: string;
}

function run<I>(cases: GoldenCase<I>[], calculate: (input: I) => unknown) {
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    if (c.error !== undefined) {
      expect(() => calculate(c.input)).toThrow(PayrollInputError);
      expect(() => calculate(c.input)).toThrow(c.error);
    } else {
      expect(calculate(c.input)).toMatchObject(c.expected ?? {});
    }
  });
}

describe("golden cases: EPF", () => {
  run(golden.epf as GoldenCase<EpfInput>[], calculateEpf);
});

describe("golden cases: SOCSO, SKBBK and EIS", () => {
  run(golden.socsoEis as GoldenCase<SocsoEisInput>[], calculateSocsoEis);
});

describe("golden cases: MTD", () => {
  run(golden.mtd as GoldenCase<MtdInput>[], calculateMtd);
});

describe("golden cases: net pay", () => {
  run(golden.netPay as GoldenCase<NetPayInput>[], calculateNetPay);
});

describe("golden cases: completeness", () => {
  const doc = readFileSync(new URL("../docs/golden-cases.md", import.meta.url), "utf8");
  const cases = [
    ...golden.epf,
    ...golden.socsoEis,
    ...golden.mtd,
    ...golden.netPay,
  ] as GoldenCase<unknown>[];
  const ids = cases.map((c) => c.id);

  const documented = [...new Set(doc.match(/\b(?:[A-Z]{2,3}-\d{2}|LHDN-EX\d)\b/g))];

  it("runs every documented case, and only those", () => {
    expect([...ids].sort()).toEqual(documented.sort());
  });

  it("has no duplicate IDs", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every case either a non-empty expected result or an error", () => {
    for (const c of cases) {
      const hasExpected = c.expected !== undefined && Object.keys(c.expected).length > 0;
      expect(hasExpected !== (c.error !== undefined), c.id).toBe(true);
    }
  });
});
