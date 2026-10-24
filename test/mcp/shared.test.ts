import { describe, expect, it } from "vitest";
import { PayrollInputError } from "../../src/core/errors.js";
import { DISCLAIMER, run } from "../../src/mcp/tools/shared.js";

describe("run", () => {
  it("adds the disclaimer to the structured content", () => {
    expect(run(() => ({ total: 1 })).structuredContent).toEqual({
      total: 1,
      disclaimer: DISCLAIMER,
    });
  });

  it("returns an input error as a tool error", () => {
    const result = run(() => {
      throw new PayrollInputError("Fix this.");
    });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Fix this." }] });
  });

  it("lets a bug through, so it isn't dressed up as the caller's mistake", () => {
    expect(() =>
      run(() => {
        throw new TypeError("bug");
      }),
    ).toThrow(TypeError);
  });
});
