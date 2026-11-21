import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildComparison,
  detectHardware,
  type Hardware,
  parseCompareModels,
  parseCompareRuns,
  percentile,
  renderComparisonMarkdown,
  runCompareCli,
} from "../../evals/comparison.js";
import type { EvalCase } from "../../evals/grading.js";
import { concurrencyFor, defaultServerModuleSpecifier, loadEvalCases } from "../../evals/runner.js";
import { buildScorecard } from "../../evals/scorecard.js";
import {
  agentAnswer,
  cleanVerdictJson,
  makeCaseEvaluation,
  makeControlEvaluation,
  makeLayer1,
} from "./helpers.ts";

const HARDWARE: Hardware = {
  platform: "darwin",
  arch: "arm64",
  cpu: "Apple M3",
  cpuCount: 8,
  memoryGib: 24,
};

function scorecardFor(params: {
  readonly agentModel: string;
  readonly durationsMs: readonly number[];
  readonly failingIds?: readonly string[];
  readonly unscoredIds?: readonly string[];
  readonly mustPassAgentErrorId?: string;
  readonly controlCaught?: boolean;
}) {
  const failing = new Set(params.failingIds ?? []);
  const unscored = new Set(params.unscoredIds ?? []);
  return buildScorecard({
    agentModel: params.agentModel,
    judgeModel: "gpt-4o",
    generatedAt: "2026-11-21T00:00:00.000Z",
    cases: params.durationsMs.map((durationMs, index) => {
      const id = `C-${index}`;
      if (id === params.mustPassAgentErrorId) {
        return makeCaseEvaluation({
          id,
          durationMs,
          isMustPass: true,
          agentError: "connection refused",
          layer1: makeLayer1({ isPassed: false, failureReasons: ["Agent error"] }),
          layer2: null,
        });
      }
      return makeCaseEvaluation({
        id,
        durationMs,
        ...(failing.has(id)
          ? { layer1: makeLayer1({ isPassed: false, failureReasons: ["wrong tool"] }) }
          : {}),
        ...(unscored.has(id) ? { layer2: null, judgeError: "judge down" } : {}),
      });
    }),
    controls: [makeControlEvaluation({ id: "K-1", isCaught: params.controlCaught ?? true })],
  });
}

/** An OpenAI-compatible endpoint: the agent calls the expected tool, then answers; the judge passes. */
function fakeChatCompletions(evalCases: readonly EvalCase[]): typeof fetch {
  const byPrompt = new Map(evalCases.map((c) => [c.prompt, c]));
  // A full Chat Completions body: the Agents SDK reads more fields than the loop's adapter does.
  const reply = (message: Record<string, unknown>, finish: string) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: "fake",
        choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: unknown[];
      messages: { role: string; content: string | null }[];
    };
    if (body.tools === undefined) return reply({ content: cleanVerdictJson() }, "stop");
    const userMessage = body.messages.find((m) => m.role === "user");
    const evalCase = byPrompt.get(String(userMessage?.content)) as EvalCase;
    if (!body.messages.some((m) => m.role === "tool")) {
      return reply(
        {
          content: null,
          tool_calls: [
            {
              id: `call_${evalCase.id}`,
              type: "function",
              function: {
                name: evalCase.expectedTool,
                arguments: JSON.stringify(evalCase.expectedInput),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    return reply({ content: agentAnswer(evalCase) }, "stop");
  };
}

describe("model comparison", () => {
  it("parses model lists and run counts strictly", () => {
    expect(parseCompareModels(" qwen3:8b, llama3.1:8b ,qwen3:8b,, ")).toEqual([
      "qwen3:8b",
      "llama3.1:8b",
    ]);
    expect(() => parseCompareModels(undefined)).toThrow("Set EVAL_COMPARE_MODELS");
    expect(() => parseCompareModels(" , ")).toThrow("Set EVAL_COMPARE_MODELS");
    expect(parseCompareRuns(undefined)).toBe(3);
    expect(parseCompareRuns("5")).toBe(5);
    expect(() => parseCompareRuns("0")).toThrow('Invalid EVAL_COMPARE_RUNS "0"');
    expect(() => parseCompareRuns("1.5")).toThrow('Invalid EVAL_COMPARE_RUNS "1.5"');
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([5], 0)).toBe(5);
  });

  it("reads hardware from node:os, tolerating a machine that reports no CPUs", () => {
    expect(
      detectHardware({
        platform: () => "darwin",
        arch: () => "arm64",
        cpus: () => [{ model: "Apple M3" }, { model: "Apple M3" }],
        totalmem: () => 24 * 1024 ** 3,
      }),
    ).toEqual({ platform: "darwin", arch: "arm64", cpu: "Apple M3", cpuCount: 2, memoryGib: 24 });
    expect(
      detectHardware({
        platform: () => "linux",
        arch: () => "x64",
        cpus: () => [],
        totalmem: () => 0,
      }).cpu,
    ).toBe("unknown");
    expect(detectHardware().cpuCount).toBeGreaterThan(0);
  });

  it("groups runs by model and summarises variance, controls, timing and scored cases", () => {
    const comparison = buildComparison({
      agentImplementation: "loop",
      agentProvider: "ollama",
      judgeProvider: "openai",
      judgeModel: "gpt-4o",
      hardware: HARDWARE,
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
            durationsMs: [500, 500],
            failingIds: ["C-0"],
            controlCaught: false,
          }),
        },
        {
          agentModel: "qwen3:8b",
          wallMs: 180_000,
          scorecard: scorecardFor({
            agentModel: "qwen3:8b",
            durationsMs: [2000, 4000],
            failingIds: ["C-1"],
          }),
        },
      ],
    });

    expect(comparison.models.map((m) => m.agentModel)).toEqual(["qwen3:8b", "llama3.1:8b"]);
    expect(comparison.models[0]).toMatchObject({
      runs: 2,
      layer1PassRateMin: 50,
      layer1PassRateMax: 100,
      layer1PassRateMean: 75,
      controlsCaught: 2,
      controlsTotal: 2,
      caseSecondsMedian: 2,
      caseSecondsP95: 4,
      runMinutesMean: 2,
      rubricMean: 5,
      scoredCases: 4,
      mustPassFailures: 0,
    });
    expect(comparison.models[1]).toMatchObject({ controlsCaught: 0, gatePasses: 0 });

    const markdown = renderComparisonMarkdown(comparison);
    expect(markdown).toContain("Agent: loop on ollama. Judge: openai/`gpt-4o` for every row.");
    expect(markdown).toContain("Hardware: Apple M3 (8 cores), 24 GiB RAM, darwin/arm64.");
    expect(markdown).toContain("| `qwen3:8b` | 2 |");
    expect(markdown).toContain("75% (50 to 100)");
    expect(markdown).toContain("| 5 (4) |");
  });

  it("counts a must-pass agent error once, under agent errors, and weights the rubric by scored case", () => {
    const comparison = buildComparison({
      agentImplementation: "loop",
      agentProvider: "ollama",
      judgeProvider: "openai",
      judgeModel: "gpt-4o",
      hardware: HARDWARE,
      runs: [
        {
          agentModel: "m",
          wallMs: 1,
          scorecard: scorecardFor({
            agentModel: "m",
            durationsMs: [1, 1, 1],
            mustPassAgentErrorId: "C-0",
            unscoredIds: ["C-1"],
          }),
        },
        {
          agentModel: "m",
          wallMs: 1,
          scorecard: scorecardFor({
            agentModel: "m",
            durationsMs: [1, 1],
            unscoredIds: ["C-0", "C-1"],
          }),
        },
      ],
    });
    const [summary] = comparison.models;
    expect(summary?.agentErrors).toBe(1);
    expect(summary?.mustPassFailures).toBe(0);
    expect(summary?.scoredCases).toBe(1);
    expect(summary?.rubricMean).toBe(5);
    expect(Date.parse(comparison.generatedAt)).not.toBeNaN();

    const allUnscored = buildComparison({
      agentImplementation: "loop",
      agentProvider: "ollama",
      judgeProvider: "ollama",
      judgeModel: "qwen3:14b",
      hardware: HARDWARE,
      runs: [
        {
          agentModel: "m",
          wallMs: 1,
          scorecard: scorecardFor({ agentModel: "m", durationsMs: [1], unscoredIds: ["C-0"] }),
        },
      ],
    });
    expect(allUnscored.models[0]?.rubricMean).toBeNull();
    expect(renderComparisonMarkdown(allUnscored)).toContain("| n/a (0) |");
  });

  it("runs the Agents SDK agent when EVAL_AGENT_IMPL=agents-sdk", async () => {
    const [evalCase] = loadEvalCases();
    const evalCases = [evalCase as EvalCase];
    const outDir = mkdtempSync(join(tmpdir(), "compare-sdk-"));
    try {
      const { comparison } = await runCompareCli(
        {
          EVAL_PROVIDER: "ollama",
          EVAL_AGENT_IMPL: "agents-sdk",
          EVAL_JUDGE_MODEL: "judge",
          EVAL_COMPARE_MODELS: "qwen3:8b",
          EVAL_COMPARE_RUNS: "1",
        },
        {
          evalCases,
          controls: [],
          fetchFn: fakeChatCompletions(evalCases),
          outDir,
          hardware: HARDWARE,
          log: () => {},
        },
      );
      // The SDK reaches the same fake endpoint as the judge, through the injected fetch.
      expect(comparison.agentImplementation).toBe("agents-sdk");
      expect(comparison.models[0]).toMatchObject({ agentErrors: 0, gatePasses: 1 });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("requires one fixed judge model so rows are comparable", async () => {
    await expect(
      runCompareCli({ EVAL_PROVIDER: "ollama", EVAL_COMPARE_MODELS: "qwen3:8b" }),
    ).rejects.toThrow("Set EVAL_JUDGE_MODEL");
  });

  it("runs every model with the same judge and writes JSON and Markdown", async () => {
    const [evalCase] = loadEvalCases();
    const evalCases = [evalCase as EvalCase];
    const outDir = mkdtempSync(join(tmpdir(), "compare-"));
    const lines: string[] = [];
    try {
      const { comparison, markdownPath } = await runCompareCli(
        {
          EVAL_PROVIDER: "ollama",
          EVAL_JUDGE_MODEL: "qwen3:14b",
          EVAL_COMPARE_MODELS: "qwen3:8b,llama3.1:8b",
          EVAL_COMPARE_RUNS: "2",
        },
        {
          evalCases,
          controls: [],
          fetchFn: fakeChatCompletions(evalCases),
          outDir,
          hardware: HARDWARE,
          log: (line) => lines.push(line),
        },
      );
      expect(comparison.judgeModel).toBe("qwen3:14b");
      expect(comparison.models.map((m) => [m.agentModel, m.runs, m.gatePasses])).toEqual([
        ["qwen3:8b", 2, 2],
        ["llama3.1:8b", 2, 2],
      ]);
      expect(readFileSync(markdownPath, "utf8")).toContain("# Agent eval model comparison");
      expect(existsSync(markdownPath.replace(/\.md$/, ".json"))).toBe(true);
      expect(lines.filter((l) => l.startsWith("Running"))).toHaveLength(4);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("defaults to every eval case and control, the console and evals/results", async () => {
    const evalCases = loadEvalCases();
    const { markdownPath } = await runCompareCli(
      {
        EVAL_PROVIDER: "ollama",
        EVAL_JUDGE_MODEL: "judge",
        EVAL_COMPARE_MODELS: "agent",
        EVAL_COMPARE_RUNS: "1",
      },
      // The fake judge passes every seeded control, so this run fails its gate.
      { fetchFn: fakeChatCompletions(evalCases) },
    );
    try {
      expect(readFileSync(markdownPath, "utf8")).toContain("| `agent` | 1 | 0/1 |");
      expect(markdownPath).toContain(join("evals", "results", "comparison-"));
    } finally {
      rmSync(markdownPath, { force: true });
      rmSync(markdownPath.replace(/\.md$/, ".json"), { force: true });
    }
  });
});

describe("shared CLI helpers", () => {
  it("uses one case at a time when either model is local, unless EVAL_CONCURRENCY is set", () => {
    expect(concurrencyFor(undefined, { agentProvider: "ollama", judgeProvider: "openai" })).toBe(1);
    expect(concurrencyFor(undefined, { agentProvider: "openai", judgeProvider: "ollama" })).toBe(1);
    expect(concurrencyFor(undefined, { agentProvider: "openai", judgeProvider: "openai" })).toBe(5);
    expect(concurrencyFor("3", { agentProvider: "ollama", judgeProvider: "ollama" })).toBe(3);
  });

  it("prefers the built server and falls back to the source", () => {
    expect(defaultServerModuleSpecifier(() => true)).toBe("../dist/mcp/server.js");
    expect(defaultServerModuleSpecifier(() => false)).toBe("../src/mcp/server.js");
    expect(defaultServerModuleSpecifier()).toMatch(/server\.js$/);
  });
});
