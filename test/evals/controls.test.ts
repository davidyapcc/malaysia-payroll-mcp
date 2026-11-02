import { describe, expect, it } from "vitest";
import {
  CONTROL_MAX_DIMENSION_SCORE,
  describeExpectation,
  isControlCaught,
  loadSeededControls,
  parseSeededControls,
  type SeededControl,
} from "../../evals/controls.js";
import type { RubricScore } from "../../evals/grading.js";

const BASE_TOOL_CALL = {
  name: "calculate_epf",
  arguments: { monthlySalary: 3000 },
  isError: false,
  textContent: "RM390.00",
  structuredContent: { employer: 390 },
};

function control(id: string, expectation: SeededControl["expectation"]): SeededControl {
  return {
    id,
    description: "d",
    prompt: "p",
    toolCalls: [BASE_TOOL_CALL],
    finalAnswer: "a",
    expectation,
  };
}

const CLEAN_SCORE: RubricScore = {
  citationFaithfulness: 5,
  completeness: 5,
  clarity: 5,
  hasHallucinatedCitation: false,
  rationale: "ok",
};

describe("seeded controls file", () => {
  it("loads the committed controls file with five validated controls", () => {
    const controls = loadSeededControls();
    expect(controls.map((c) => c.id)).toEqual([
      "CTRL-INVENTED-CITATION",
      "CTRL-NO-DISCLAIMER",
      "CTRL-SWAPPED-PAYER",
      "CTRL-WRONG-AMOUNT",
      "CTRL-SILENT-RETRY",
    ]);
    expect(controls.every((c) => c.toolCalls.length > 0)).toBe(true);
  });

  it("rejects a file that is not a non-empty array of controls", () => {
    expect(() => parseSeededControls("{}")).toThrow("Invalid seeded controls file");
    expect(() => parseSeededControls("[]")).toThrow("Invalid seeded controls file");
  });

  it("rejects a control with an unknown expectation dimension", () => {
    const bad = JSON.stringify([
      {
        id: "CTRL-X",
        description: "d",
        prompt: "p",
        toolCalls: [BASE_TOOL_CALL],
        finalAnswer: "a",
        expectation: { kind: "dimension", dimension: "accuracy" },
      },
    ]);
    expect(() => parseSeededControls(bad)).toThrow("Invalid seeded controls file");
  });

  it("rejects duplicate control IDs", () => {
    const twice = JSON.stringify([
      control("CTRL-DUP", { kind: "hallucination" }),
      control("CTRL-DUP", { kind: "hallucination" }),
    ]);
    expect(() => parseSeededControls(twice)).toThrow('Duplicate seeded control ID "CTRL-DUP".');
  });

  it("leaves structuredContent off a tool call that has none", () => {
    const { structuredContent: _unused, ...withoutStructured } = BASE_TOOL_CALL;
    const [parsed] = parseSeededControls(
      JSON.stringify([
        { ...control("CTRL-NS", { kind: "hallucination" }), toolCalls: [withoutStructured] },
      ]),
    );
    expect(parsed?.toolCalls[0]).not.toHaveProperty("structuredContent");
    expect(parsed?.toolCalls[0]?.textContent).toBe("RM390.00");
  });

  it("rejects malformed JSON text", () => {
    expect(() => parseSeededControls("[not json")).toThrow(SyntaxError);
  });
});

describe("isControlCaught", () => {
  it("catches a hallucination control only when the judge flags hallucinatedCitation", () => {
    const hallucination = control("CTRL-H", { kind: "hallucination" });
    expect(isControlCaught(hallucination, { ...CLEAN_SCORE, hasHallucinatedCitation: true })).toBe(
      true,
    );
    expect(isControlCaught(hallucination, CLEAN_SCORE)).toBe(false);
  });

  it("catches a dimension control only when the named dimension is at or below the constant", () => {
    const dimension = control("CTRL-D", { kind: "dimension", dimension: "completeness" });
    expect(CONTROL_MAX_DIMENSION_SCORE).toBe(3);
    expect(isControlCaught(dimension, { ...CLEAN_SCORE, completeness: 3 })).toBe(true);
    expect(isControlCaught(dimension, { ...CLEAN_SCORE, completeness: 4 })).toBe(false);
    expect(isControlCaught(dimension, { ...CLEAN_SCORE, citationFaithfulness: 1 })).toBe(false);
  });

  it("describes each expectation for the Scorecard", () => {
    expect(describeExpectation({ kind: "hallucination" })).toBe("Flag a hallucinated citation");
    expect(describeExpectation({ kind: "dimension", dimension: "clarity" })).toBe(
      "Score clarity at or below 3",
    );
  });
});
