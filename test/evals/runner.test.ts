import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSeededControls, type SeededControl } from "../../evals/controls.js";
import type { EvalCase } from "../../evals/grading.js";
import type {
  LlmClient,
  MessagesCreateParams,
  MessagesResponseLike,
} from "../../evals/providers.js";
import { runCli } from "../../evals/run.js";
import { loadEvalCases, runEvalSuite, writeScorecardFiles } from "../../evals/runner.js";
import { buildScorecard, DEFAULT_THRESHOLDS } from "../../evals/scorecard.js";
import {
  agentAnswer,
  catchingJudgeReply,
  cleanVerdictJson,
  createFakeLlm,
  judgeCaseId,
} from "./helpers.ts";

const TEST_CONCURRENCY = 5;

function firstCase(): EvalCase {
  const [first] = loadEvalCases();
  if (first === undefined) throw new Error("No eval cases loaded.");
  return first;
}

function isJudgeRequest(params: MessagesCreateParams): boolean {
  return params.tools === undefined;
}

/** Fails the judge call for `caseId` on every attempt with `reason`, and answers everything else. */
function judgeFailingFor(
  base: LlmClient,
  caseId: string,
  reason: string,
  onJudgeCall?: (id: string) => void,
): LlmClient {
  return {
    messages: {
      create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
        if (isJudgeRequest(params) && onJudgeCall !== undefined) {
          onJudgeCall(judgeCaseId(String(params.messages[0]?.content)));
        }
        const message = String(params.messages[0]?.content);
        if (isJudgeRequest(params) && message.includes(`Case ID: ${caseId}\n`)) {
          return Promise.reject(new Error(reason));
        }
        return base.messages.create(params);
      },
    },
  };
}

describe("judge retries and judge errors", () => {
  it("retries a failed judge call once and records the retried score", async () => {
    const evalCase = firstCase();
    let attempts = 0;
    const base = createFakeLlm({
      evalCases: [evalCase],
      judgeReply: (caseId) => {
        if (caseId === evalCase.id) {
          attempts++;
          if (attempts === 1) throw new Error("transient 502");
        }
        return cleanVerdictJson();
      },
    });

    const scorecard = await runEvalSuite({ evalCases: [evalCase], llm: base, controls: [] });

    expect(attempts).toBe(2);
    expect(scorecard.cases[0]?.layer2?.completeness).toBe(5);
    expect(scorecard.cases[0]?.judgeError).toBeNull();
    expect(scorecard.judgeErrors).toBe(0);
  });

  it("records a judge that fails twice as a judge error, not as a hallucination or a zero score", async () => {
    const evalCase = firstCase();
    const calls: string[] = [];
    const llm = judgeFailingFor(
      createFakeLlm({ evalCases: [evalCase], judgeReply: () => cleanVerdictJson() }),
      evalCase.id,
      "upstream 503",
      (id) => calls.push(id),
    );

    const scorecard = await runEvalSuite({ evalCases: [evalCase], llm, controls: [] });

    expect(calls.filter((id) => id === evalCase.id)).toHaveLength(2);
    expect(scorecard.cases[0]?.layer2).toBeNull();
    expect(scorecard.cases[0]?.judgeError).toBe("upstream 503");
    expect(scorecard.judgeErrors).toBe(1);
    expect(scorecard.layer2Summary.hallucinatedCitations).toBe(0);
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toContainEqual(expect.stringContaining("Judge errors: 1"));
  });

  it("excludes a judge-errored case from the rubric mean instead of averaging it as 1/1/1", async () => {
    const [failing, passing] = loadEvalCases().filter(
      (c) => c.id === "EPF-01" || c.id === "EPF-02",
    );
    if (failing === undefined || passing === undefined) throw new Error("Missing EPF cases.");
    const llm = judgeFailingFor(
      createFakeLlm({ evalCases: [failing, passing], judgeReply: () => cleanVerdictJson() }),
      failing.id,
      "upstream 503",
    );

    const scorecard = await runEvalSuite({
      evalCases: [failing, passing],
      llm,
      controls: [],
    });

    expect(scorecard.layer2Summary.scoredCases).toBe(1);
    expect(scorecard.layer2Summary.overallMean).toBe(5);
  });

  it("records a judge reply with no JSON object as a judge error that names the parse failure", async () => {
    const evalCase = firstCase();
    const llm = createFakeLlm({
      evalCases: [evalCase],
      judgeReply: () => "no json here",
    });

    const scorecard = await runEvalSuite({ evalCases: [evalCase], llm, controls: [] });

    expect(scorecard.cases[0]?.judgeError).toContain("did not contain a JSON object");
  });

  it("records a judge that rejects with a non-Error value using its string form", async () => {
    const evalCase = firstCase();
    const base = createFakeLlm({ evalCases: [evalCase], judgeReply: () => cleanVerdictJson() });
    const llm: LlmClient = {
      messages: {
        create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
          if (isJudgeRequest(params)) return Promise.reject("judge network down");
          return base.messages.create(params);
        },
      },
    };

    const scorecard = await runEvalSuite({ evalCases: [evalCase], llm, controls: [] });

    expect(scorecard.cases[0]?.judgeError).toBe("judge network down");
  });

  it("records a judge error for a control, and counts it in judgeErrors rather than as missed", async () => {
    const controls = loadSeededControls();
    const [target] = controls;
    if (target === undefined) throw new Error("No seeded controls.");
    const llm = judgeFailingFor(
      createFakeLlm({ evalCases: [], judgeReply: catchingJudgeReply(controls) }),
      target.id,
      "upstream 500",
    );

    const scorecard = await runEvalSuite({ evalCases: [], llm, controls });

    expect(scorecard.judgeErrors).toBe(1);
    expect(scorecard.controlSummary.missedIds).toEqual([]);
    expect(scorecard.controls[0]?.judgeError).toBe("upstream 500");
  });
});

describe("agent loop and suite-level gating", () => {
  it("applies a thresholds override passed to the suite runner", async () => {
    const evalCase = firstCase();
    const llm = createFakeLlm({ evalCases: [evalCase], judgeReply: () => cleanVerdictJson() });
    const impossible = { ...DEFAULT_THRESHOLDS, minMeanRubricScore: 6 };

    const scorecard = await runEvalSuite({
      evalCases: [evalCase],
      llm,
      controls: [],
      thresholds: impossible,
    });

    expect(scorecard.thresholds.minMeanRubricScore).toBe(6);
    expect(scorecard.gateFailures).toContainEqual(expect.stringContaining("threshold 6.00/5.00"));
  });

  it("records a non-object tool input as empty arguments", async () => {
    const evalCase = firstCase();
    const base = createFakeLlm({ evalCases: [evalCase], judgeReply: () => cleanVerdictJson() });
    let agentRound = 0;
    const llm: LlmClient = {
      messages: {
        create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
          if (isJudgeRequest(params)) return base.messages.create(params);
          agentRound++;
          if (agentRound === 1) {
            return Promise.resolve({
              stop_reason: "tool_use",
              content: [
                { type: "tool_use", id: "call_1", name: evalCase.expectedTool, input: "oops" },
              ],
            });
          }
          return Promise.resolve({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "RM0.00" }],
          });
        },
      },
    };

    const scorecard = await runEvalSuite({ evalCases: [evalCase], llm, controls: [] });

    expect(scorecard.cases[0]?.toolCalls[0]?.arguments).toEqual({});
  });

  it("runs all 35 cases and seeded controls through the MCP server and passes the gate when the judge catches every control", async () => {
    const evalCases = loadEvalCases();
    const controls = loadSeededControls();
    const llm = createFakeLlm({ evalCases, judgeReply: catchingJudgeReply(controls) });

    const scorecard = await runEvalSuite({
      evalCases,
      llm,
      controls,
      concurrency: TEST_CONCURRENCY,
    });

    expect(scorecard.totalCases).toBe(35);
    expect(scorecard.layer1Summary.total).toBe(34);
    expect(scorecard.layer1Summary.passed).toBe(34);
    expect(scorecard.mustPassSummary).toEqual({
      passed: 1,
      total: 1,
      failedIds: [],
      isCausingFailure: false,
    });
    expect(scorecard.layer2Summary.overallMean).toBe(5);
    expect(scorecard.layer2Summary.hallucinatedCitations).toBe(0);
    expect(scorecard.controlSummary).toEqual({ caught: 4, total: 4, missedIds: [] });
    expect(scorecard.judgeErrors).toBe(0);
    expect(scorecard.isGatePassed).toBe(true);
  });

  it("fails the gate and lists every control when the judge passes all of them", async () => {
    const evalCases = loadEvalCases();
    const controls = loadSeededControls();
    const llm = createFakeLlm({ evalCases, judgeReply: () => cleanVerdictJson() });

    const scorecard = await runEvalSuite({ evalCases, llm, controls });

    expect(scorecard.controlSummary.caught).toBe(0);
    expect(scorecard.controlSummary.missedIds).toEqual(controls.map((c) => c.id));
    expect(scorecard.isGatePassed).toBe(false);
    expect(scorecard.gateFailures).toEqual([
      `Judge passed ${controls.length} seeded control(s) it must catch: ${controls.map((c) => c.id).join(", ")}.`,
    ]);
  });

  it("fails the gate when a refusal case's answer affirms the opt-out", async () => {
    const evalCases = loadEvalCases();
    const soc05 = evalCases.find((c) => c.id === "SOC-05");
    if (soc05 === undefined) throw new Error("Missing SOC-05.");
    const base = createFakeLlm({ evalCases, judgeReply: () => cleanVerdictJson() });
    const llm: LlmClient = {
      messages: {
        create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
          const isSoc05Answer =
            !isJudgeRequest(params) &&
            params.messages[0]?.content === soc05.prompt &&
            params.messages.length > 1;
          if (!isSoc05Answer) return base.messages.create(params);
          return Promise.resolve({
            stop_reason: "end_turn",
            content: [{ type: "text", text: `${agentAnswer(soc05)} Yes, you can opt out.` }],
          });
        },
      },
    };

    const scorecard = await runEvalSuite({ evalCases, llm, controls: [] });

    expect(scorecard.mustPassSummary.isCausingFailure).toBe(true);
    expect(scorecard.mustPassSummary.failedIds).toEqual(["SOC-05"]);
    expect(scorecard.isGatePassed).toBe(false);
  });
});

describe("scorecard file output and CLI exit codes", () => {
  it("writes scorecard JSON, markdown and step-summary files", () => {
    const scorecard = buildScorecard({
      cases: [],
      controls: [],
      agentModel: "mock-agent",
      judgeModel: "mock-judge",
    });
    const tempDir = mkdtempSync(join(tmpdir(), "payroll-eval-test-"));
    try {
      const summaryFile = join(tempDir, "step-summary.md");
      writeScorecardFiles(scorecard, tempDir, undefined);
      const { jsonPath, markdownPath } = writeScorecardFiles(scorecard, tempDir, summaryFile);
      const writtenJson = JSON.parse(readFileSync(jsonPath, "utf8"));
      const writtenMd = readFileSync(markdownPath, "utf8");
      const summaryMd = readFileSync(summaryFile, "utf8");
      expect(writtenJson.totalCases).toBe(0);
      expect(writtenMd).toContain("Malaysia Payroll MCP — Agent Eval Scorecard (FAIL)");
      expect(summaryMd).toContain("## Layer 1: Deterministic Tool-Use Summary");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs runCli and returns exit code 0 when every gate passes", async () => {
    const evalCase = firstCase();
    const controls = loadSeededControls();
    const tempDir = mkdtempSync(join(tmpdir(), "payroll-cli-test-"));
    try {
      const exitCode = await runCli(
        { OPENAI_API_KEY: "sk-test", EVAL_PROVIDER: "openai" },
        {
          evalCases: [evalCase],
          fetchFn: createScriptedOpenAiFetch([evalCase], controls),
          outDir: tempDir,
        },
      );
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs runCli and returns exit code 1 when the eval gate fails", async () => {
    const evalCase = firstCase();
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "No tool called." } }],
        }),
        { status: 200 },
      );

    const tempDir = mkdtempSync(join(tmpdir(), "payroll-cli-fail-test-"));
    try {
      const exitCode = await runCli(
        { OPENAI_API_KEY: "sk-test", EVAL_PROVIDER: "openai" },
        { evalCases: [evalCase], fetchFn: mockFetch, outDir: tempDir },
      );
      expect(exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * OpenAI-shaped fetch for runCli: the agent calls the expected tool, then answers correctly. The
 * judge (identified by its "Case ID:" message) catches every seeded control.
 */
function createScriptedOpenAiFetch(
  evalCases: readonly EvalCase[],
  controls: readonly SeededControl[],
): typeof fetch {
  const judgeReply = catchingJudgeReply(controls);
  const chatReply = (message: Record<string, unknown>) =>
    new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), {
      status: 200,
    });

  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; content?: unknown }[];
    };
    const firstUser = String(body.messages.find((m) => m.role === "user")?.content);
    if (firstUser.startsWith("Case ID:")) {
      return chatReply({ content: judgeReply(judgeCaseId(firstUser)) });
    }
    const evalCase = evalCases.find((c) => c.prompt === firstUser);
    if (evalCase === undefined) throw new Error(`Unknown prompt: ${firstUser}`);
    if (body.messages.some((m) => m.role === "tool")) {
      return chatReply({ content: agentAnswer(evalCase) });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: evalCase.expectedTool,
                    arguments: JSON.stringify(evalCase.expectedInput),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
}
