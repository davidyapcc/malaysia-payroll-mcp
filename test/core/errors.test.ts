import { describe, expect, it } from "vitest";
import { PayrollInputError, tableInEffect } from "../../src/core/errors.js";
import { NoTableInEffectError } from "../../src/tables/index.js";

describe("tableInEffect", () => {
  it("returns the table", () => {
    expect(tableInEffect((payPeriod) => payPeriod, "2026-11")).toBe("2026-11");
  });

  it("turns a missing table into an input error with the same message", () => {
    const lookup = () => {
      throw new NoTableInEffectError("epf", "2025-09", "2025-10-01");
    };
    expect(() => tableInEffect(lookup, "2025-09")).toThrow(
      new PayrollInputError(
        "No epf rate table is in effect for pay period 2025-09; the earliest starts 2025-10-01.",
      ),
    );
  });

  it("lets any other error through", () => {
    const lookup = () => {
      throw new TypeError("boom");
    };
    expect(() => tableInEffect(lookup, "2026-11")).toThrow(TypeError);
  });
});
