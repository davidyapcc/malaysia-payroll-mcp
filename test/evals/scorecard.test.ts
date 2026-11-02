import { describe, expect, it } from "vitest";
import {
  buildScorecard,
  DEFAULT_THRESHOLDS,
  LAYER1_ALLOWED_MISSES,
  renderScorecardMarkdown,
} from "../../evals/scorecard.js";
import { makeCaseEvaluation, makeControlEvaluation, makeLayer1 } from "./helpers.ts";

const STANDARD_TOTAL = 34;

function standardCases(passing: number) {
  return Array.from({ length: STANDARD_TOTAL }, (_, index) =>
    makeCaseEvaluation({
      id: `STD-${index}`,
      layer1: makeLayer1({ isPassed: index < passing }),
    }),
  );
}

const PASSING_MUST_PASS = makeCaseEvaluation({
  id: "SOC-05",
  isMustPass: true,
  expectedTool: "calculate_socso_eis",
});

const FAILING_MUST_PASS = makeCaseEvaluation({
  id: "SOC-05",
  isMustPass: true,
  expectedTool: "calculate_socso_eis",
  layer1: makeLayer1({ isPassed: false, failureReasons: ["Refused in prose."] }),
});

function scorecardFor(
  cases: ReturnType<typeof standardCases>,
  extra: Partial<Parameters<typeof buildScorecard>[0]> = {},
) {
  return buildScorecard({ cases, controls: [], agentModel: "a", judgeModel: "j", ...extra });
}

describe("Layer 1 threshold derivation and must-pass refusal cases", () => {
  it("derives the Layer 1 threshold from two allowed misses over standard cases only", () => {
    expect(LAYER1_ALLOWED_MISSES).toBe(2);
    expect(DEFAULT_THRESHOLDS.maxLayer1Misses).toBe(LAYER1_ALLOWED_MISSES);

    const scorecard = scorecardFor([...standardCases(32), PASSING_MUST_PASS]);
    expect(scorecard.layer1Summary.total).toBe(STANDARD_TOTAL);
    expect(scorecard.layer1Summary.minPassed).toBe(32);
    expect(scorecard.isGatePassed).toBe(true);
  });

  it("fails the gate when standard Layer 1 passes drop below 32 of 34", () => {
    const scorecard = scorecardFor([...standardCases(31), PASSING_MUST_PASS]);
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toEqual([
      "Layer 1 deterministic pass count 31/34 is below threshold 32/34 (2 misses allowed; refusal cases excluded).",
    ]);
  });

  it("fails the gate on a must-pass refusal case alone, even with every standard case passing", () => {
    const scorecard = scorecardFor([...standardCases(STANDARD_TOTAL), FAILING_MUST_PASS]);
    expect(scorecard.mustPassSummary).toEqual({
      passed: 0,
      total: 1,
      failedIds: ["SOC-05"],
      isCausingFailure: true,
    });
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toEqual([
      "Must-pass refusal case(s) failed Layer 1: SOC-05. Refusal cases must pass regardless of the suite count.",
    ]);
  });

  it("reports the must-pass result as not causing a failure when the refusal case passes", () => {
    const scorecard = scorecardFor([...standardCases(STANDARD_TOTAL), PASSING_MUST_PASS]);
    expect(scorecard.mustPassSummary).toEqual({
      passed: 1,
      total: 1,
      failedIds: [],
      isCausingFailure: false,
    });
    expect(scorecard.isGatePassed).toBe(true);
  });
});

describe("Layer 2 aggregation and judge errors", () => {
  it("excludes a judge-errored case from the rubric mean and from hallucination counts", () => {
    const judgeFailed = makeCaseEvaluation({
      id: "EPF-01",
      layer2: null,
      judgeError: "upstream 503",
    });
    const scorecard = scorecardFor([...standardCases(STANDARD_TOTAL), judgeFailed]);
    expect(scorecard.layer2Summary.scoredCases).toBe(STANDARD_TOTAL);
    expect(scorecard.layer2Summary.overallMean).toBe(5);
    expect(scorecard.layer2Summary.hallucinatedCitations).toBe(0);
    expect(scorecard.judgeErrors).toBe(1);
  });

  it("fails the gate with its own message when any judge error occurs", () => {
    const judgeFailed = makeCaseEvaluation({
      id: "EPF-01",
      layer2: null,
      judgeError: "upstream 503",
    });
    const scorecard = scorecardFor([...standardCases(STANDARD_TOTAL), judgeFailed]);
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toEqual([
      "Judge errors: 1 case(s) or control(s) could not be scored after one retry. Any judge error fails the gate.",
    ]);
  });

  it("reports an overall mean of zero, and fails the mean gate, when no case was scored", () => {
    const scorecard = scorecardFor([
      makeCaseEvaluation({ id: "EPF-01", layer2: null, judgeError: "down" }),
    ]);
    expect(scorecard.layer2Summary.scoredCases).toBe(0);
    expect(scorecard.layer2Summary.overallMean).toBe(0);
    expect(scorecard.gateFailures[0]).toContain("Layer 2 mean rubric score 0.00/5.00");
  });

  it("fails the gate on a mean below threshold and on a hallucinated citation", () => {
    const weak = makeCaseEvaluation({
      id: "EPF-01",
      layer2: {
        citationFaithfulness: 2,
        completeness: 3,
        clarity: 3,
        hasHallucinatedCitation: true,
        rationale: "Invented.",
      },
    });
    const scorecard = scorecardFor([weak]);
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toHaveLength(2);
    expect(scorecard.gateFailures[1]).toBe(
      "Layer 2 detected 1 case(s) with hallucinated citations (max allowed: 0).",
    );
  });
});

describe("seeded controls in the gate", () => {
  it("fails the gate and lists each control the judge passed", () => {
    const missed = makeControlEvaluation({ id: "CTRL-NO-DISCLAIMER", isCaught: false });
    const scorecard = scorecardFor(standardCases(STANDARD_TOTAL), { controls: [missed] });
    expect(scorecard.controlSummary).toEqual({
      caught: 0,
      total: 1,
      missedIds: ["CTRL-NO-DISCLAIMER"],
    });
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toEqual([
      "Judge passed 1 seeded control(s) it must catch: CTRL-NO-DISCLAIMER.",
    ]);
  });

  it("passes the gate when the judge catches every control", () => {
    const caught = [
      makeControlEvaluation({ id: "CTRL-A", isCaught: true }),
      makeControlEvaluation({ id: "CTRL-B", isCaught: true }),
    ];
    const scorecard = scorecardFor(standardCases(STANDARD_TOTAL), { controls: caught });
    expect(scorecard.controlSummary).toEqual({ caught: 2, total: 2, missedIds: [] });
    expect(scorecard.isGatePassed).toBe(true);
  });

  it("counts a control judge error as a judge error, not a missed control", () => {
    const errored = makeControlEvaluation({
      id: "CTRL-A",
      judgment: null,
      judgeError: "upstream 503",
      isCaught: false,
    });
    const scorecard = scorecardFor(standardCases(STANDARD_TOTAL), { controls: [errored] });
    expect(scorecard.judgeErrors).toBe(1);
    expect(scorecard.controlSummary.missedIds).toEqual([]);
    expect(scorecard.gateFailures).toEqual([expect.stringContaining("Judge errors: 1")]);
  });
});

describe("renderScorecardMarkdown", () => {
  it("states that the must-pass result caused a failure, and lists the failed refusal ID", () => {
    const md = renderScorecardMarkdown(
      scorecardFor([...standardCases(STANDARD_TOTAL), FAILING_MUST_PASS]),
    );
    expect(md).toContain("# Malaysia Payroll MCP — Agent Eval Scorecard (FAIL)");
    expect(md).toContain("- **Caused gate failure**: yes. SOC-05 failed Layer 1");
    expect(md).toContain("| 0 | 1 | SOC-05 |");
    expect(md).toContain("| SOC-05 | `calculate_socso_eis` | FAIL (must-pass) |");
  });

  it("states that the must-pass result did not cause a failure when it passed", () => {
    const md = renderScorecardMarkdown(
      scorecardFor([...standardCases(STANDARD_TOTAL), PASSING_MUST_PASS]),
    );
    expect(md).toContain("- **Caused gate failure**: no.");
    expect(md).toContain("| SOC-05 | `calculate_socso_eis` | PASS (must-pass) |");
  });

  it("renders judge-errored cases with n/a scores and the error note", () => {
    const md = renderScorecardMarkdown(
      scorecardFor([
        makeCaseEvaluation({
          id: "EPF-01",
          layer1: makeLayer1({ isPassed: false, failureReasons: ["Missing | amount."] }),
          layer2: null,
          judgeError: "upstream\n503",
        }),
      ]),
    );
    expect(md).toContain(
      "| EPF-01 | `calculate_epf` | FAIL | n/a | n/a | n/a | n/a | Missing \\| amount. \\| Judge error: upstream 503 |",
    );
    expect(md).toContain("| Judge errors (after one retry) | 1 |");
  });

  it("lists every seeded control with what the judge must do and whether it was caught", () => {
    const md = renderScorecardMarkdown(
      scorecardFor(standardCases(STANDARD_TOTAL), {
        controls: [
          makeControlEvaluation({
            id: "CTRL-A",
            expectation: { kind: "dimension", dimension: "clarity" },
            isCaught: false,
          }),
          makeControlEvaluation({ id: "CTRL-B", isCaught: true }),
        ],
      }),
    );
    expect(md).toContain("| CTRL-A | Score clarity at or below 3 | NO |");
    expect(md).toContain("| CTRL-B | Flag a hallucinated citation | YES |");
    expect(md).toContain("- **Caught**: 1 of 2. **Missed**: CTRL-A.");
  });

  it("marks a hallucinated citation as YES in the per-case table", () => {
    const md = renderScorecardMarkdown(
      scorecardFor([
        makeCaseEvaluation({
          id: "EPF-09",
          layer2: {
            citationFaithfulness: 2,
            completeness: 3,
            clarity: 3,
            hasHallucinatedCitation: true,
            rationale: "Invented.",
          },
        }),
      ]),
    );
    expect(md).toContain("| EPF-09 | `calculate_epf` | PASS | 2 | 3 | 3 | YES | Invented. |");
  });

  it("renders no gate-failure section when the gate passes", () => {
    const md = renderScorecardMarkdown(scorecardFor(standardCases(STANDARD_TOTAL)));
    expect(md).toContain("(PASS)");
    expect(md).not.toContain("## Gate Failures");
  });
});
