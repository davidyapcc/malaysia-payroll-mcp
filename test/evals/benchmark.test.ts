import { describe, expect, it } from "vitest";
import {
  buildBenchmarkReport,
  parseBenchModels,
  parseBenchRuns,
  percentile,
  renderBenchmarkMarkdown,
} from "../../evals/benchmark.js";
import { buildScorecard } from "../../evals/scorecard.js";
import { makeCaseEvaluation, makeControlEvaluation, makeLayer1 } from "./helpers.ts";

function scorecardFor(params: {
  readonly agentModel: string;
  readonly failingIds?: readonly string[];
  readonly durationsMs: readonly number[];
  readonly controlCaught?: boolean;
}) {
  const failing = new Set(params.failingIds ?? []);
  return buildScorecard({
    agentModel: params.agentModel,
    judgeModel: "judge-model",
    generatedAt: "2026-11-21T00:00:00.000Z",
    cases: params.durationsMs.map((durationMs, index) => {
      const id = `C-${index}`;
      return makeCaseEvaluation({
        id,
        durationMs,
        ...(failing.has(id)
          ? { layer1: makeLayer1({ isPassed: false, failureReasons: ["wrong tool"] }) }
          : {}),
      });
    }),
    controls: [makeControlEvaluation({ id: "K-1", isCaught: params.controlCaught ?? true })],
  });
}

describe("benchmark aggregation", () => {
  it("parses model lists and run counts strictly", () => {
    expect(parseBenchModels(" qwen3:8b, llama3.1:8b ,qwen3:8b,, ")).toEqual([
      "qwen3:8b",
      "llama3.1:8b",
    ]);
    expect(() => parseBenchModels(undefined)).toThrow("Set EVAL_BENCH_MODELS");
    expect(() => parseBenchModels(" , ")).toThrow("Set EVAL_BENCH_MODELS");
    expect(parseBenchRuns(undefined)).toBe(3);
    expect(parseBenchRuns(" ")).toBe(3);
    expect(parseBenchRuns("5")).toBe(5);
    expect(() => parseBenchRuns("0")).toThrow('Invalid EVAL_BENCH_RUNS "0"');
    expect(() => parseBenchRuns("1.5")).toThrow('Invalid EVAL_BENCH_RUNS "1.5"');
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([5], 0)).toBe(5);
  });

  it("groups runs by model and reports variance, gate passes, controls and timing", () => {
    const report = buildBenchmarkReport({
      agentProvider: "ollama",
      judgeProvider: "openai",
      generatedAt: "2026-11-21T00:00:00.000Z",
      runs: [
        {
          agentModel: "qwen3:8b",
          wallMs: 60_000,
          scorecard: scorecardFor({ agentModel: "qwen3:8b", durationsMs: [1000, 3000] }),
        },
        {
          agentModel: "llama3.1:8b",
          wallMs: 30_000,
          scorecard: scorecardFor({
            agentModel: "llama3.1:8b",
            failingIds: ["C-0"],
            durationsMs: [500, 500],
            controlCaught: false,
          }),
        },
        {
          agentModel: "qwen3:8b",
          wallMs: 180_000,
          scorecard: scorecardFor({
            agentModel: "qwen3:8b",
            failingIds: ["C-1"],
            durationsMs: [2000, 4000],
          }),
        },
      ],
    });

    expect(report.models.map((m) => m.agentModel)).toEqual(["qwen3:8b", "llama3.1:8b"]);
    const qwen = report.models[0];
    expect(qwen).toMatchObject({
      judgeModel: "judge-model",
      runs: 2,
      layer1PassRateMin: 50,
      layer1PassRateMax: 100,
      layer1PassRateMean: 75,
      controlsCaught: 2,
      controlsTotal: 2,
      caseSecondsMedian: 2,
      caseSecondsP95: 4,
      runMinutesMean: 2,
      agentErrors: 0,
      judgeErrors: 0,
      hallucinatedCitations: 0,
      mustPassFailures: 0,
    });
    expect(report.models[1]).toMatchObject({ controlsCaught: 0, gatePasses: 0 });

    const markdown = renderBenchmarkMarkdown(report);
    expect(markdown).toContain("Agent provider: ollama. Judge: openai (judge-model).");
    expect(markdown).toContain("| `qwen3:8b` | 2 |");
    expect(markdown).toContain("75% (50 to 100)");
    expect(markdown).toContain("| 2 / 4 | 2 |");
  });

  it("stamps the current time when none is given and handles an empty run list", () => {
    const report = buildBenchmarkReport({ runs: [], agentProvider: "a", judgeProvider: "b" });
    expect(Date.parse(report.generatedAt)).not.toBeNaN();
    expect(report.models).toEqual([]);
  });
});
