import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEvalSpecs,
  buildScorecard,
  canonicalizeArgs,
  containsRmAmount,
  DEFAULT_THRESHOLDS,
  evaluateLayer1,
  type GoldenFile,
  headlineNumbers,
  loadEvalSpecs,
  matchesExpectedObject,
  parseCasesJsonl,
  parseJudgeResponse,
  renderScorecardMarkdown,
} from "../evals/grading.js";
import {
  type AnthropicClientLike,
  createOpenAiClient,
  type MessagesCreateParams,
  type MessagesResponseLike,
  runEvalSuite,
  writeScorecardFiles,
} from "../evals/run.js";
import golden from "./golden/cases.json" with { type: "json" };

describe("evals/cases.jsonl completeness", () => {
  const specs = loadEvalSpecs();
  const goldenIds = [...golden.epf, ...golden.socsoEis, ...golden.mtd, ...golden.netPay].map(
    (c) => c.id,
  );

  it("maps 1:1 to all 35 golden cases in test/golden/cases.json", () => {
    expect(specs).toHaveLength(35);
    expect(specs.map((s) => s.id).sort()).toEqual([...goldenIds].sort());
  });

  it("rejects malformed JSONL lines, duplicate IDs, unknown IDs and missing golden cases", () => {
    expect(() => parseCasesJsonl("[]")).toThrow("expected a JSON object");
    expect(() => parseCasesJsonl('{"id":"","prompt":"hi"}')).toThrow(
      'missing non-empty string "id"',
    );
    expect(() => parseCasesJsonl('{"id":"EPF-01","prompt":"  "}')).toThrow(
      'missing non-empty string "prompt"',
    );

    const smallGolden: GoldenFile = {
      epf: [{ id: "EPF-01", input: { monthlySalary: 10 }, expected: { total: 0 } }],
      socsoEis: [],
      mtd: [],
      netPay: [],
    };
    expect(() =>
      buildEvalSpecs(smallGolden, [
        { id: "EPF-01", prompt: "one" },
        { id: "EPF-01", prompt: "two" },
      ]),
    ).toThrow('Duplicate eval case ID "EPF-01"');

    expect(() => buildEvalSpecs(smallGolden, [{ id: "UNKNOWN-99", prompt: "unknown" }])).toThrow(
      'Eval case "UNKNOWN-99" does not exist',
    );

    expect(() => buildEvalSpecs(smallGolden, [])).toThrow(
      'Golden case "EPF-01" has no prompt in evals/cases.jsonl.',
    );
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

  it("matches formatted RM numbers by numeric value without false substring matches", () => {
    expect(containsRmAmount("Employer pays RM 3,000.00 and employee pays RM 2,750.", 3000)).toBe(
      true,
    );
    expect(containsRmAmount("EIS contribution is RM 5.90 each.", 5.9)).toBe(true);
    expect(containsRmAmount("Employee share is nil (exempt at age 65).", 0)).toBe(true);
    expect(containsRmAmount("Chargeable income P is RM 47,000.07 in 2026.", 70)).toBe(false);
  });

  it("evaluates SOC-05 error handling and detects missing numbers or wrong tools", () => {
    const specs = loadEvalSpecs();
    const soc05 = specs.find((s) => s.id === "SOC-05");
    const epf02 = specs.find((s) => s.id === "EPF-02");
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
    expect(soc05Pass.passed).toBe(true);

    const epfFail = evaluateLayer1(
      epf02,
      [
        {
          name: "calculate_epf",
          arguments: { ...epf02.expectedInput, monthlySalary: 9999 },
          isError: false,
          textContent: "{}",
          structuredContent: { part: "A", employer: 390, employee: 330, total: 720 },
        },
      ],
      "The employer pays RM 390.00.",
    );
    expect(epfFail.passed).toBe(false);
    expect(epfFail.argsMatched).toBe(false);
    expect(epfFail.numbersInProse).toBe(false);
    expect(epfFail.missingNumbers).toEqual([330]);
    expect(matchesExpectedObject(null, { a: 1 })).toBe(false);
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
      hallucinatedCitation: false,
      rationale: "Exact citations and clear breakdown.",
    });

    const lowCite = parseJudgeResponse(
      '{"citationFaithfulness": 2, "completeness": 4, "clarity": 4, "hallucinatedCitation": false, "rationale": "Invented a wrong band."}',
    );
    expect(lowCite.hallucinatedCitation).toBe(true);

    expect(() => parseJudgeResponse("no json here")).toThrow("did not contain a JSON object");
    expect(() =>
      parseJudgeResponse(
        '{"citationFaithfulness": 6, "completeness": 4, "clarity": 4, "hallucinatedCitation": false, "rationale": "bad"}',
      ),
    ).toThrow('field "citationFaithfulness" must be an integer from 1 to 5');
  });
});

describe("End-to-end eval harness over all 35 golden cases (in-memory MCP server)", () => {
  it("runs all 35 cases through the MCP server and passes both Layer 1 and Layer 2 gates", async () => {
    const specs = loadEvalSpecs();
    const specByPrompt = new Map(specs.map((s) => [s.prompt, s]));

    const mockAnthropic: AnthropicClientLike = {
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

          if (params.messages.length === 1) {
            const promptText = params.messages[0]?.content;
            const spec = typeof promptText === "string" ? specByPrompt.get(promptText) : undefined;
            if (!spec) throw new Error(`Unknown prompt: ${String(promptText)}`);

            return {
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: `call_${spec.id}`,
                  name: spec.expectedTool,
                  input: spec.expectedInput,
                },
              ],
            };
          }

          const promptText = params.messages[0]?.content;
          const spec = typeof promptText === "string" ? specByPrompt.get(promptText) : undefined;
          if (!spec) throw new Error("Missing spec on second turn");

          if (spec.expectedError !== undefined) {
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

          const nums = headlineNumbers(spec)
            .map((n) => `RM ${n.toFixed(2)}`)
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
      specs,
      anthropic: mockAnthropic,
      agentModel: "mock-agent",
      judgeModel: "mock-judge",
      concurrency: 5,
    });

    expect(scorecard.totalCases).toBe(35);
    expect(scorecard.layer1Summary.passed).toBe(35);
    expect(scorecard.layer2Summary.overallMean).toBe(5);
    expect(scorecard.layer2Summary.hallucinatedCitations).toBe(0);
    expect(scorecard.gatePassed).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "payroll-eval-test-"));
    try {
      const { jsonPath, markdownPath } = writeScorecardFiles(scorecard, tempDir);
      const writtenJson = JSON.parse(readFileSync(jsonPath, "utf8"));
      const writtenMd = readFileSync(markdownPath, "utf8");
      expect(writtenJson.totalCases).toBe(35);
      expect(writtenMd).toContain("Malaysia Payroll MCP — Agent Eval Scorecard (PASS)");
      expect(writtenMd).toContain("| EPF-01 |");
      expect(writtenMd).toContain("| NP-05 |");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails the gate when Layer 1, Layer 2 mean or hallucinated citations breach thresholds", () => {
    const failedScorecard = buildScorecard({
      cases: [
        {
          id: "EPF-01",
          prompt: "test",
          expectedTool: "calculate_epf",
          toolCalls: [],
          finalAnswer: "bad answer",
          layer1: {
            passed: false,
            toolSelected: false,
            argsMatched: false,
            toolOutputMatched: false,
            numbersInProse: false,
            missingNumbers: [0],
            failureReasons: ["No tool called."],
          },
          layer2: {
            citationFaithfulness: 2,
            completeness: 3,
            clarity: 3,
            hallucinatedCitation: true,
            rationale: "Hallucinated citation.",
          },
          durationMs: 10,
        },
      ],
      agentModel: "test-agent",
      judgeModel: "test-judge",
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(failedScorecard.gatePassed).toBe(false);
    expect(failedScorecard.gateFailures).toHaveLength(3);
    const md = renderScorecardMarkdown(failedScorecard);
    expect(md).toContain("## Gate Failures");
    expect(md).toContain("| EPF-01 | `calculate_epf` | FAIL |");
  });

  it("adapts OpenAI Chat Completions tool calls and responses via createOpenAiClient", async () => {
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
                  content: null,
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
                content: "Employee RM 330.00, Employer RM 390.00.",
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = createOpenAiClient("sk-test-openai", "https://api.openai.com/v1", mockFetch);
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
    expect(first.content[0]).toMatchObject({
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
        { role: "assistant", content: first.content as never },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "{}" }],
        },
      ],
    });

    expect(second.stop_reason).toBe("end_turn");
    expect(second.content[0]).toEqual({
      type: "text",
      text: "Employee RM 330.00, Employer RM 390.00.",
    });
  });
});
