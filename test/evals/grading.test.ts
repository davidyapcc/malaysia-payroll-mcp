import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEvalCases,
  canonicalizeArgs,
  containsRmAmount,
  type EvalCase,
  evaluateLayer1,
  type GoldenFile,
  headlineAmounts,
  isMustPassCase,
  isPlainObject,
  matchesExpectedObject,
  parseCasesJsonl,
  parseJudgeResponse,
  type RecordedToolCall,
} from "../../evals/grading.js";
import { loadEvalCases } from "../../evals/runner.js";
import golden from "../golden/cases.json" with { type: "json" };

function findCase(id: string): EvalCase {
  const found = loadEvalCases().find((c) => c.id === id);
  if (found === undefined) throw new Error(`Missing eval case ${id}`);
  return found;
}

/** The expected refusal: SOC-05's own arguments, with the statutory error as the tool output. */
function soc05Refusal(): RecordedToolCall {
  return {
    name: "calculate_socso_eis",
    arguments: findCase("SOC-05").expectedInput,
    isError: true,
    textContent: "Foreign workers can't opt out of SKBBK",
  };
}

describe("evals/cases.jsonl completeness and validation", () => {
  const evalCases = loadEvalCases();
  const goldenIds = [...golden.epf, ...golden.socsoEis, ...golden.mtd, ...golden.netPay].map(
    (c) => c.id,
  );

  it("maps 1:1 to all 35 golden cases in test/golden/cases.json", () => {
    expect(evalCases).toHaveLength(35);
    expect(evalCases.map((s) => s.id).sort()).toEqual([...goldenIds].sort());
  });

  it("states every numeric input in the prompt, except the tax category code", () => {
    const numbersIn = (text: string) =>
      (text.replaceAll(",", "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const numericInputs = (input: Record<string, unknown>): number[] =>
      Object.entries(input).flatMap(([key, value]) => {
        if (key === "taxCategory") return [];
        if (typeof value === "number") return [value];
        return isPlainObject(value) ? numericInputs(value) : [];
      });

    const missing = evalCases.flatMap((evalCase) =>
      numericInputs(evalCase.expectedInput)
        .filter((value) => !numbersIn(evalCase.prompt).includes(value))
        .map((value) => `${evalCase.id}: ${value}`),
    );

    expect(missing).toEqual([]);
  });

  it("keeps grader hints out of the EPF, MTD and net pay prompts", () => {
    const graderHints =
      /\btax category\b|\b\d{4}-\d{2}\b|same salary|\bonly\b|employee, employer and total|\bnon-Malaysian\b|statutory deductions|employer contributions|year-to-date|qualifying/i;
    const coached = evalCases
      .filter((evalCase) => evalCase.expectedTool !== "calculate_socso_eis")
      .filter((evalCase) => graderHints.test(evalCase.prompt))
      .map((evalCase) => evalCase.id);

    expect(coached).toEqual([]);
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
          new URL("../../evals/cases.jsonl", import.meta.url),
          pathToFileURL(badGoldenPath),
        ),
      ).toThrow("Invalid golden cases file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Layer 1: argument canonicalization and number matching", () => {
  it("normalizes optional schema defaults for EPF and SOCSO/EIS", () => {
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
  });

  it("normalizes optional schema defaults for MTD January and mid-year", () => {
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
    expect(containsRmAmount("You are not exempt: employee pays RM1.30.", 0)).toBe(false);
  });

  it("evaluates SOC-05 refusal explanation and rejects acceptance claims", () => {
    const evalCases = loadEvalCases();
    const soc05 = evalCases.find((s) => s.id === "SOC-05");
    expect(soc05).toBeDefined();
    if (!soc05) return;

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

    const soc05Acceptance = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: true,
          textContent: "Foreign workers can't opt out of SKBBK",
        },
      ],
      "Yes, foreign workers can opt out of SKBBK.",
    );
    expect(soc05Acceptance.isPassed).toBe(false);
    expect(soc05Acceptance.hasValidProse).toBe(false);

    const soc05NotAvailable = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: true,
          textContent: "Foreign workers can't opt out of SKBBK",
        },
      ],
      "Opting out is not available for foreign workers, so these figures assume SKBBK cover.",
    );
    expect(soc05NotAvailable.hasValidProse).toBe(true);

    const soc05NotAvailableAlt = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: true,
          textContent: "Foreign workers can't opt out of SKBBK",
        },
      ],
      "The opt-out isn't available to foreign workers.",
    );
    expect(soc05NotAvailableAlt.hasValidProse).toBe(true);

    const soc05AvailableOptOut = evaluateLayer1(
      soc05,
      [
        {
          name: "calculate_socso_eis",
          arguments: soc05.expectedInput,
          isError: true,
          textContent: "Foreign workers can't opt out of SKBBK",
        },
      ],
      "Opting out is available for foreign workers.",
    );
    expect(soc05AvailableOptOut.hasValidProse).toBe(false);
  });

  it("fails Layer 1 when expected tool is missing or incorrect tool is called", () => {
    const evalCases = loadEvalCases();
    const soc05 = evalCases.find((s) => s.id === "SOC-05");
    expect(soc05).toBeDefined();
    if (!soc05) return;

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
  });

  it("fails Layer 1 on unexpected tool errors or missing expected errors", () => {
    const evalCases = loadEvalCases();
    const soc05 = evalCases.find((s) => s.id === "SOC-05");
    const epf02 = evalCases.find((s) => s.id === "EPF-02");
    expect(soc05).toBeDefined();
    expect(epf02).toBeDefined();
    if (!soc05 || !epf02) return;

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
  });

  it("fails Layer 1 on argument mismatches, output mismatches, and missing amounts", () => {
    const evalCases = loadEvalCases();
    const epf02 = evalCases.find((s) => s.id === "EPF-02");
    expect(epf02).toBeDefined();
    if (!epf02) return;

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
    expect(epfFail.hasValidProse).toBe(false);
    expect(epfFail.missingAmounts).toEqual([330, 720]);
  });

  it("handles custom cases with no expected golden output", () => {
    const evalCases = loadEvalCases();
    const epf02 = evalCases.find((s) => s.id === "EPF-02");
    expect(epf02).toBeDefined();
    if (!epf02) return;

    const noExpectedCase = {
      id: "CUSTOM-01",
      prompt: "custom",
      expectedTool: "calculate_epf" as const,
      expectedInput: epf02.expectedInput,
    };
    expect(headlineAmounts(noExpectedCase)).toEqual([]);
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
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
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

describe("Layer 1: employer and employee shares name their party", () => {
  it("fails an answer that swaps the employer and employee shares", () => {
    const result = evaluateLayer1(
      findCase("EPF-02"),
      [epf02Call()],
      "The employer pays RM330.00 and the employee pays RM390.00, a total of RM720.00.",
    );
    expect(result.hasValidProse).toBe(false);
    expect(result.missingAmounts).toEqual([390, 330]);
  });

  it("accepts shares named by party in inline, labelled and table phrasings", () => {
    const epf02 = findCase("EPF-02");
    const phrasings = [
      "Employee contributes RM 330.00, employer RM 390.00, total RM 720.00.",
      "Employee: RM330.00\nEmployer: RM390.00\nTotal: RM720.00",
      "| Employee | RM330.00 |\n| Employer | RM390.00 |\n| Total | RM720.00 |",
      "RM330.00 (employee) and RM390.00 (employer), total RM720.00.",
    ];
    for (const answer of phrasings) {
      expect(evaluateLayer1(epf02, [epf02Call()], answer).hasValidProse).toBe(true);
    }
  });

  it("names the party for each EPF share and leaves the total unlabelled", () => {
    const epf = findCase("EPF-02");
    expect(headlineAmounts(epf)).toEqual([
      { amount: 390, party: "employer" },
      { amount: 330, party: "employee" },
      { amount: 720, party: null },
    ]);
  });

  it("counts a nil share as the named party's amount", () => {
    const epf = findCase("EPF-02");
    const answer = "Employee: nil\nEmployer: RM390.00\nTotal: RM390.00";
    const result = evaluateLayer1(
      { ...epf, expectedOutput: { employer: 390, employee: 0, total: 390 } },
      [epf02Call()],
      answer,
    );
    expect(result.missingAmounts).toEqual([]);
  });
});

function epf02Call(): RecordedToolCall {
  const epf02 = findCase("EPF-02");
  return {
    name: "calculate_epf",
    arguments: epf02.expectedInput,
    isError: false,
    textContent: "{}",
    structuredContent: { part: "A", employer: 390, employee: 330, total: 720 },
  };
}

describe("Layer 1: must-pass refusal cases", () => {
  it("identifies refusal cases by expectedError and leaves other cases as standard", () => {
    expect(isMustPassCase(findCase("SOC-05"))).toBe(true);
    expect(isMustPassCase(findCase("SOC-01"))).toBe(false);
  });

  it("allows retry calls after the expected refusal when the answer explains it", () => {
    const soc05 = findCase("SOC-05");
    const retry: RecordedToolCall = {
      name: "calculate_socso_eis",
      arguments: { ...soc05.expectedInput, skbbkStatus: "covered" },
      isError: false,
      textContent: "{}",
      structuredContent: {},
    };
    const result = evaluateLayer1(
      soc05,
      [soc05Refusal(), retry],
      "Foreign workers cannot opt out of SKBBK (Lindung 24 Jam).",
    );
    expect(result.hasExpectedTool).toBe(true);
    expect(result.isPassed).toBe(true);
    expect(result.failureReasons).toEqual([]);
  });

  it("keeps standard cases single-call and fails a second tool call", () => {
    const epf02 = findCase("EPF-02");
    const second: RecordedToolCall = {
      name: "calculate_epf",
      arguments: epf02.expectedInput,
      isError: false,
      textContent: "{}",
      structuredContent: {},
    };
    const result = evaluateLayer1(epf02, [second, second], "RM390.00 RM330.00 RM720.00");
    expect(result.hasExpectedTool).toBe(false);
    expect(result.isPassed).toBe(false);
    expect(result.failureReasons[0]).toContain("Expected single tool call");
  });

  it("fails a refusal case whose first call used the wrong tool, even if a retry is correct", () => {
    const soc05 = findCase("SOC-05");
    const wrongFirst: RecordedToolCall = {
      name: "calculate_mtd",
      arguments: {},
      isError: true,
      textContent: "Foreign workers can't opt out of SKBBK",
    };
    const correctRetry: RecordedToolCall = {
      name: "calculate_socso_eis",
      arguments: soc05.expectedInput,
      isError: true,
      textContent: "Foreign workers can't opt out of SKBBK",
    };
    const result = evaluateLayer1(
      soc05,
      [wrongFirst, correctRetry],
      "Foreign workers cannot opt out of SKBBK.",
    );
    expect(result.hasExpectedTool).toBe(false);
    expect(result.isPassed).toBe(false);
    expect(result.failureReasons[0]).toContain('Expected first tool call to "calculate_socso_eis"');
  });

  it("fails an answer that affirms the opt-out, with its own failure reason", () => {
    const result = evaluateLayer1(
      findCase("SOC-05"),
      [soc05Refusal()],
      "Yes, you can opt out of SKBBK.",
    );
    expect(result.isPassed).toBe(false);
    expect(result.hasValidProse).toBe(false);
    expect(result.failureReasons).toContain(
      "Final answer affirms the opt-out, which the statute does not allow.",
    );
  });

  it("fails an answer that does not explain the refusal", () => {
    const result = evaluateLayer1(findCase("SOC-05"), [soc05Refusal()], "Calculated as requested.");
    expect(result.isPassed).toBe(false);
    expect(result.failureReasons).toEqual([
      "Final answer did not clearly explain the statutory refusal.",
    ]);
  });

  it("fails RM amounts presented when no tool call succeeded (invented figures)", () => {
    const result = evaluateLayer1(
      findCase("SOC-05"),
      [soc05Refusal()],
      "Cannot opt out of SKBBK, which is mandatory. The employee pays RM 20.00 for SKBBK.",
    );
    expect(result.isPassed).toBe(false);
    expect(result.failureReasons).toEqual([
      "Final answer presents RM amounts although no tool call succeeded.",
    ]);
  });

  it("allows RM amounts in a refusal answer when a retry succeeded", () => {
    const soc05 = findCase("SOC-05");
    const succeeded: RecordedToolCall = {
      name: "calculate_socso_eis",
      arguments: soc05.expectedInput,
      isError: false,
      textContent: "{}",
      structuredContent: {},
    };
    const result = evaluateLayer1(
      soc05,
      [soc05Refusal(), succeeded],
      "Cannot opt out of SKBBK, which is mandatory. The employee pays RM 20.00 for SKBBK.",
    );
    expect(result.hasValidProse).toBe(true);
  });
});
