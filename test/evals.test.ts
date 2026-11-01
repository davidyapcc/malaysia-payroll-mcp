import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEvalCases,
  buildScorecard,
  canonicalizeArgs,
  containsRmAmount,
  DEFAULT_THRESHOLDS,
  evaluateLayer1,
  type GoldenFile,
  headlineNumbers,
  matchesExpectedObject,
  parseCasesJsonl,
  parseJudgeResponse,
  renderScorecardMarkdown,
} from "../evals/grading.js";
import {
  createOpenAiClient,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type LlmClient,
  type MessagesCreateParams,
  type MessagesResponseLike,
  resolveProvider,
} from "../evals/providers.js";
import {
  loadEvalCases,
  parseConcurrency,
  runEvalSuite,
  writeScorecardFiles,
} from "../evals/runner.js";
import golden from "./golden/cases.json" with { type: "json" };

describe("evals/cases.jsonl completeness and validation", () => {
  const evalCases = loadEvalCases();
  const goldenIds = [...golden.epf, ...golden.socsoEis, ...golden.mtd, ...golden.netPay].map(
    (c) => c.id,
  );

  it("maps 1:1 to all 35 golden cases in test/golden/cases.json", () => {
    expect(evalCases).toHaveLength(35);
    expect(evalCases.map((s) => s.id).sort()).toEqual([...goldenIds].sort());
  });

  it("rejects malformed JSONL lines, invalid golden files, duplicate IDs, unknown IDs and missing golden cases", () => {
    expect(() => parseCasesJsonl("[]")).toThrow("cases.jsonl:1");
    expect(() => parseCasesJsonl('{"id":"","prompt":"hi"}')).toThrow("cases.jsonl:1");
    expect(() => parseCasesJsonl('{"id":"EPF-01","prompt":"  "}')).toThrow("cases.jsonl:1");

    const smallGolden: GoldenFile = {
      epf: [{ id: "EPF-01", input: { monthlySalary: 10 }, expected: { total: 0 } }],
      socsoEis: [],
      mtd: [],
      netPay: [],
    };
    expect(() =>
      buildEvalCases(smallGolden, [
        { id: "EPF-01", prompt: "one" },
        { id: "EPF-01", prompt: "two" },
      ]),
    ).toThrow('Duplicate eval case ID "EPF-01"');

    expect(() => buildEvalCases(smallGolden, [{ id: "UNKNOWN-99", prompt: "unknown" }])).toThrow(
      'Eval case "UNKNOWN-99" does not exist',
    );

    expect(() => buildEvalCases(smallGolden, [])).toThrow(
      'Golden case "EPF-01" has no prompt in evals/cases.jsonl.',
    );

    const tempDir = mkdtempSync(join(tmpdir(), "payroll-bad-golden-"));
    try {
      const badGoldenPath = join(tempDir, "bad-golden.json");
      writeFileSync(badGoldenPath, JSON.stringify({ epf: "not-an-array" }), "utf8");
      expect(() =>
        loadEvalCases(
          new URL("../evals/cases.jsonl", import.meta.url),
          pathToFileURL(badGoldenPath),
        ),
      ).toThrow("Invalid golden cases file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Layer 1: argument canonicalization and number matching", () => {
  it("normalizes optional schema defaults across all four tools", () => {
    expect(
      canonicalizeArgs("calculate_epf", {
        monthlySalary: 3000,
        age: 30,
        citizenship: "malaysian",
        payPeriod: "2026-11",
      }),
    ).toEqual(
      canonicalizeArgs("calculate_epf", {
        monthlySalary: 3000,
        age: 30,
        citizenship: "malaysian",
        registeredWithEpfBefore1Aug1998: false,
        payPeriod: "2026-11",
      }),
    );

    expect(
      canonicalizeArgs("calculate_socso_eis", {
        monthlySalary: 3000,
        age: 30,
        citizenship: "malaysian",
        eisPayableBefore57: true,
        payPeriod: "2026-11",
      }),
    ).toEqual(
      canonicalizeArgs("calculate_socso_eis", {
        monthlySalary: 3000,
        age: 30,
        citizenship: "malaysian",
        skbbkStatus: "covered",
        payPeriod: "2026-11",
      }),
    );

    expect(
      canonicalizeArgs("calculate_mtd", {
        monthlySalary: 5000,
        epfEmployee: 550,
        taxCategory: 1,
        payPeriod: "2026-01",
        yearToDate: { remuneration: 0, epf: 0, mtd: 0 },
      }),
    ).toEqual(
      canonicalizeArgs("calculate_mtd", {
        monthlySalary: 5000,
        epfEmployee: 550,
        taxResident: true,
        taxCategory: 1,
        children: 0,
        tp1Reliefs: 0,
        payPeriod: "2026-01",
      }),
    );

    expect(
      canonicalizeArgs("calculate_mtd", {
        monthlySalary: 5500,
        epfEmployee: 605,
        taxCategory: 3,
        children: 3,
        payPeriod: "2026-02",
        yearToDate: { remuneration: 5500, epf: 605, mtd: 110 },
      }),
    ).toEqual(
      canonicalizeArgs("calculate_mtd", {
        monthlySalary: 5500,
        epfEmployee: 605,
        taxResident: true,
        taxCategory: 3,
        children: 3,
        tp1Reliefs: 0,
        payPeriod: "2026-02",
        yearToDate: { remuneration: 5500, epf: 605, mtd: 110, tp1Reliefs: 0 },
      }),
    );
  });

  it("ignores resident-only fields when taxResident is false (NP-05 and MTD-06)", () => {
    const goldenNp05 = {
      monthlySalary: 5000,
      age: 30,
      citizenship: "non_malaysian",
      taxCategory: 1,
      yearToDate: "same_salary_all_year",
      payPeriod: "2026-11",
      taxResident: false,
    };
    const agentNp05 = {
      monthlySalary: 5000,
      age: 30,
      citizenship: "non_malaysian",
      payPeriod: "2026-11",
      taxResident: false,
    };
    expect(canonicalizeArgs("calculate_net_pay", agentNp05)).toEqual(
      canonicalizeArgs("calculate_net_pay", goldenNp05),
    );
  });

  it("matches server RM550.00 format and rejects percentages, ages, years and 'none'", () => {
    expect(containsRmAmount("EPF: employee RM550.00, employer RM650.00.", 550)).toBe(true);
    expect(containsRmAmount("EPF: employee RM550.00, employer RM650.00.", 0)).toBe(false);
    expect(containsRmAmount("Employer pays RM 3,000 and employee pays 2,750.00.", 3000)).toBe(true);
    expect(containsRmAmount("EIS contribution is RM 5.90 each.", 5.9)).toBe(true);
    expect(containsRmAmount("Employee share is nil (exempt at age 65).", 0)).toBe(true);
    expect(containsRmAmount("There are none.", 0)).toBe(false);
    expect(containsRmAmount("Employee aged 30 at rate 11% in 2026.", 30)).toBe(false);
    expect(containsRmAmount("Employee aged 30 at rate 11% in 2026.", 11)).toBe(false);
    expect(containsRmAmount("Chargeable income P is RM 47,000.07 in 2026.", 70)).toBe(false);
  });

  it("evaluates SOC-05 error handling and detects missing tool calls, bad outputs or missing numbers", () => {
    const evalCases = loadEvalCases();
    const soc05 = evalCases.find((s) => s.id === "SOC-05");
    const epf02 = evalCases.find((s) => s.id === "EPF-02");
    expect(soc05).toBeDefined();
    expect(epf02).toBeDefined();
    if (!soc05 || !epf02) return;

    const soc05Pass = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: true,
          textContent: "Foreign workers can't opt out of SKBBK",
        },
      ],
      "Foreign workers cannot opt out of SKBBK (Lindung 24 Jam); coverage is mandatory.",
    );
    expect(soc05Pass.isPassed).toBe(true);

    const soc05NoTool = evaluateLayer1(soc05, [], "Foreign workers cannot opt out of SKBBK.");
    expect(soc05NoTool.isPassed).toBe(false);
    expect(soc05NoTool.hasExpectedTool).toBe(false);

    const soc05WrongTool = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_mtd",
          arguments: {},
          isError: false,
          textContent: "{}",
        },
      ],
      "Foreign workers cannot opt out of SKBBK.",
    );
    expect(soc05WrongTool.hasExpectedTool).toBe(false);
    expect(soc05WrongTool.failureReasons[0]).toContain("calculate_mtd");

    const soc05WrongError = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: false,
          textContent: "ok",
        },
      ],
      "All good.",
    );
    expect(soc05WrongError.hasMatchingToolOutput).toBe(false);
    expect(soc05WrongError.hasExpectedProseAmounts).toBe(false);

    const epfFail = evaluateLayer1(
      epf02,
      [
        {
          name: "calculate_epf",
          arguments: { ...epf02.expectedInput, monthlySalary: 9999 },
          isError: false,
          textContent: "{}",
          structuredContent: { part: "A", employer: 999, employee: 330, total: 720 },
        },
      ],
      "The employer pays RM390.00.",
    );
    expect(epfFail.isPassed).toBe(false);
    expect(epfFail.hasMatchingArgs).toBe(false);
    expect(epfFail.hasMatchingToolOutput).toBe(false);
    expect(epfFail.hasExpectedProseAmounts).toBe(false);
    expect(epfFail.missingAmounts).toEqual([330, 720]);

    const epfToolError = evaluateLayer1(
      epf02,
      [
        {
          name: "calculate_epf",
          arguments: epf02.expectedInput,
          isError: true,
          textContent: "unexpected failure",
        },
      ],
      "RM390.00 RM330.00 RM720.00",
    );
    expect(epfToolError.hasMatchingToolOutput).toBe(false);

    const noExpectedCase = {
      id: "CUSTOM-01",
      prompt: "custom",
      expectedTool: "calculate_epf" as const,
      expectedInput: epf02.expectedInput,
    };
    expect(headlineNumbers(noExpectedCase)).toEqual([]);
    const customLayer1 = evaluateLayer1(
      noExpectedCase,
      [
        {
          name: "calculate_epf",
          arguments: epf02.expectedInput,
          isError: false,
          textContent: "{}",
          structuredContent: { part: "A" },
        },
      ],
      "Done.",
    );
    expect(customLayer1.isPassed).toBe(true);

    expect(matchesExpectedObject(null, { a: 1 })).toBe(false);
    expect(matchesExpectedObject({ nested: { a: 1 } }, { nested: { a: 2 } })).toBe(false);
  });
});

describe("Layer 2: judge JSON parser", () => {
  it("parses fenced or plain JSON and flags low citation faithfulness as hallucinated", () => {
    const clean = parseJudgeResponse(
      '```json\n{"citationFaithfulness": 5, "completeness": 4, "clarity": 5, "hallucinatedCitation": false, "rationale": "Exact citations and clear breakdown."}\n```',
    );
    expect(clean).toEqual({
      citationFaithfulness: 5,
      completeness: 4,
      clarity: 5,
      hasHallucinatedCitation: false,
      rationale: "Exact citations and clear breakdown.",
    });

    const lowCite = parseJudgeResponse(
      '{"citationFaithfulness": 2, "completeness": 4, "clarity": 4, "hallucinatedCitation": false, "rationale": "Invented a wrong band."}',
    );
    expect(lowCite.hasHallucinatedCitation).toBe(true);

    expect(() => parseJudgeResponse("no json here")).toThrow("did not contain a JSON object");
    expect(() =>
      parseJudgeResponse(
        '{"citationFaithfulness": 6, "completeness": 4, "clarity": 4, "hallucinatedCitation": false, "rationale": "bad"}',
      ),
    ).toThrow("Invalid judge JSON");
  });
});

describe("Providers and concurrency validation", () => {
  it("validates EVAL_PROVIDER, API keys and EVAL_CONCURRENCY strictly", () => {
    expect(() => resolveProvider({ EVAL_PROVIDER: "typo" })).toThrow(
      'Invalid EVAL_PROVIDER "typo"',
    );
    expect(() => resolveProvider({})).toThrow(
      "Missing API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    );
    expect(() => resolveProvider({ EVAL_PROVIDER: "anthropic" })).toThrow(
      'EVAL_PROVIDER is "anthropic", but ANTHROPIC_API_KEY is not set.',
    );
    expect(() => resolveProvider({ EVAL_PROVIDER: "openai" })).toThrow(
      'EVAL_PROVIDER is "openai", but OPENAI_API_KEY is not set.',
    );

    const anthropicProvider = resolveProvider({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(anthropicProvider.agentModel).toBe(DEFAULT_ANTHROPIC_MODEL);

    const openAiProvider = resolveProvider({ OPENAI_API_KEY: "sk-proj-test" });
    expect(openAiProvider.agentModel).toBe(DEFAULT_OPENAI_MODEL);

    const explicitOpenAi = resolveProvider({
      EVAL_PROVIDER: "openai",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-proj-test",
      EVAL_AGENT_MODEL: "gpt-4o",
      EVAL_JUDGE_MODEL: "gpt-4o",
    });
    expect(explicitOpenAi.agentModel).toBe("gpt-4o");
    expect(explicitOpenAi.judgeModel).toBe("gpt-4o");

    expect(parseConcurrency(undefined)).toBe(5);
    expect(parseConcurrency("3")).toBe(3);
    expect(() => parseConcurrency("abc")).toThrow('Invalid EVAL_CONCURRENCY "abc"');
    expect(() => parseConcurrency("0")).toThrow('Invalid EVAL_CONCURRENCY "0"');
    expect(() => createOpenAiClient("   ")).toThrow("OPENAI_API_KEY must be a non-empty string.");
  });

  it("adapts OpenAI Chat Completions and surfaces HTTP, schema and malformed JSON errors", async () => {
    const requests: unknown[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "Calling tool...",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "calculate_epf",
                        arguments: JSON.stringify({
                          monthlySalary: 3000,
                          age: 30,
                          citizenship: "malaysian",
                          payPeriod: "2026-11",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Employee RM330.00, Employer RM390.00, Total RM720.00.",
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = createOpenAiClient("sk-test-openai", mockFetch);
    const first = await client.messages.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      temperature: 0,
      system: "sys",
      tools: [
        {
          name: "calculate_epf",
          description: "desc",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });

    expect(first.stop_reason).toBe("tool_use");
    expect(first.content[1]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "calculate_epf",
      input: { monthlySalary: 3000, age: 30, citizenship: "malaysian", payPeriod: "2026-11" },
    });

    const second = await client.messages.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      temperature: 0,
      system: "sys",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking..." },
            { type: "tool_use", id: "call_1", name: "calculate_epf" },
          ] as never,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_2", name: "calculate_epf" }] as never,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Just text" }] as never,
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "{}" }],
        },
      ],
    });
    expect(second.stop_reason).toBe("end_turn");

    const errorClient = createOpenAiClient(
      "sk-test",
      async () => new Response("bad key", { status: 401 }),
    );
    await expect(
      errorClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("OpenAI API error (401): bad key");

    const badShapeClient = createOpenAiClient(
      "sk-test",
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      badShapeClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Invalid OpenAI response shape");

    const badArgsClient = createOpenAiClient(
      "sk-test",
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    { id: "c1", function: { name: "calculate_epf", arguments: "{not-json" } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await expect(
      badArgsClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow();
  });
});

describe("End-to-end eval harness over all 35 golden cases (in-memory MCP server)", () => {
  it("runs all 35 cases through the MCP server and passes both Layer 1 and Layer 2 gates", async () => {
    const evalCases = loadEvalCases();
    const caseByPrompt = new Map(evalCases.map((c) => [c.prompt, c]));

    const mockLlm: LlmClient = {
      messages: {
        async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
          if (params.tools === undefined) {
            return {
              stop_reason: "end_turn",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    citationFaithfulness: 5,
                    completeness: 5,
                    clarity: 5,
                    hallucinatedCitation: false,
                    rationale: "Faithful citation and exact statutory figures.",
                  }),
                },
              ],
            };
          }

          const promptText = params.messages[0]?.content;
          const evalCase =
            typeof promptText === "string" ? caseByPrompt.get(promptText) : undefined;
          if (!evalCase) throw new Error(`Unknown prompt: ${String(promptText)}`);

          if (params.messages.length === 1) {
            return {
              stop_reason: "tool_use",
              content: [
                { type: "text", text: "Checking tool..." },
                {
                  type: "tool_use",
                  id: `call_${evalCase.id}`,
                  name: evalCase.expectedTool,
                  input: evalCase.expectedInput,
                },
              ],
            };
          }

          if (evalCase.expectedError !== undefined) {
            return {
              stop_reason: "end_turn",
              content: [
                {
                  type: "text",
                  text: "Foreign workers cannot opt out of SKBBK (Lindung 24 Jam). Not tax advice; fixed salaries only.",
                },
              ],
            };
          }

          const nums = headlineNumbers(evalCase)
            .map((n) => `RM${n.toFixed(2)}`)
            .join(", ");
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: `Statutory figures: ${nums}. Cited from official rate table. Not tax or legal advice; fixed monthly salaries only.`,
              },
            ],
          };
        },
      },
    };

    const scorecard = await runEvalSuite({
      evalCases,
      llm: mockLlm,
      agentModel: "mock-agent",
      judgeModel: "mock-judge",
      concurrency: 5,
    });

    expect(scorecard.totalCases).toBe(35);
    expect(scorecard.layer1Summary.passed).toBe(35);
    expect(scorecard.layer2Summary.overallMean).toBe(5);
    expect(scorecard.layer2Summary.hallucinatedCitations).toBe(0);
    expect(scorecard.isGatePassed).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "payroll-eval-test-"));
    try {
      const summaryFile = join(tempDir, "step-summary.md");
      writeScorecardFiles(scorecard, tempDir, undefined);
      const { jsonPath, markdownPath } = writeScorecardFiles(scorecard, tempDir, summaryFile);
      const writtenJson = JSON.parse(readFileSync(jsonPath, "utf8"));
      const writtenMd = readFileSync(markdownPath, "utf8");
      const summaryMd = readFileSync(summaryFile, "utf8");
      expect(writtenJson.totalCases).toBe(35);
      expect(writtenMd).toContain("Malaysia Payroll MCP — Agent Eval Scorecard (PASS)");
      expect(summaryMd).toContain("| NP-05 |");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records a failed rubric score instead of aborting the suite when a judge reply is malformed", async () => {
    const [firstCase] = loadEvalCases();
    expect(firstCase).toBeDefined();
    if (!firstCase) return;

    const badJudgeLlm: LlmClient = {
      messages: {
        async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
          if (params.tools === undefined) {
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: "not valid json" }],
            };
          }
          if (params.messages.length === 1) {
            return {
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "call_1",
                  name: firstCase.expectedTool,
                  input: "not-an-object",
                },
              ],
            };
          }
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "RM0.00" }],
          };
        },
      },
    };

    const scorecard = await runEvalSuite({
      evalCases: [firstCase],
      llm: badJudgeLlm,
    });
    expect(scorecard.totalCases).toBe(1);
    expect(scorecard.cases[0]?.layer2.hasHallucinatedCitation).toBe(true);
    expect(scorecard.cases[0]?.layer2.rationale).toContain("Judge evaluation failed");
  });

  it("fails the gate when Layer 1, Layer 2 mean or hallucinated citations breach thresholds", () => {
    const emptyScorecard = buildScorecard({
      cases: [],
      agentModel: "test-agent",
      judgeModel: "test-judge",
    });
    expect(emptyScorecard.layer1Summary.passRate).toBe(0);
    expect(renderScorecardMarkdown(emptyScorecard)).toContain("0.0%");

    const failedScorecard = buildScorecard({
      cases: [
        {
          id: "EPF-01",
          prompt: "test",
          expectedTool: "calculate_epf",
          toolCalls: [],
          finalAnswer: "bad answer",
          layer1: {
            isPassed: false,
            hasExpectedTool: false,
            hasMatchingArgs: false,
            hasMatchingToolOutput: false,
            hasExpectedProseAmounts: false,
            missingAmounts: [0],
            failureReasons: ["No tool called."],
          },
          layer2: {
            citationFaithfulness: 2,
            completeness: 3,
            clarity: 3,
            hasHallucinatedCitation: true,
            rationale: "Hallucinated citation.",
          },
          durationMs: 10,
        },
      ],
      agentModel: "test-agent",
      judgeModel: "test-judge",
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(failedScorecard.isGatePassed).toBe(false);
    expect(failedScorecard.gateFailures).toHaveLength(3);
    const md = renderScorecardMarkdown(failedScorecard);
    expect(md).toContain("## Gate Failures");
    expect(md).toContain("| EPF-01 | `calculate_epf` | FAIL |");
  });
});
