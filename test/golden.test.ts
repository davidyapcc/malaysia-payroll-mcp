// Runs every golden case through the core. The cases are the source of truth (test/golden/);
// docs/golden-cases.md explains each one.
import { describe, expect, it } from "vitest";
import { calculateEpf, type EpfInput } from "../src/core/epf.js";
import { PayrollInputError } from "../src/core/errors.js";
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
