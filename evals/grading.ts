// Pure grading, canonicalization and scorecard formatting for the two-layer agent eval (ADR 0004).
import { readFileSync } from "node:fs";

export type ToolName =
  | "calculate_epf"
  | "calculate_socso_eis"
  | "calculate_mtd"
  | "calculate_net_pay";

export interface EvalPromptEntry {
  readonly id: string;
  readonly prompt: string;
}

export interface GoldenCaseEntry {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly expected?: Record<string, unknown>;
  readonly error?: string;
}

export interface GoldenFile {
  readonly epf: readonly GoldenCaseEntry[];
  readonly socsoEis: readonly GoldenCaseEntry[];
  readonly mtd: readonly GoldenCaseEntry[];
  readonly netPay: readonly GoldenCaseEntry[];
}

export interface EvalSpec {
  readonly id: string;
  readonly prompt: string;
  readonly expectedTool: ToolName;
  readonly expectedInput: Record<string, unknown>;
  readonly expectedOutput?: Record<string, unknown>;
  readonly expectedError?: string;
}

export interface RecordedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly isError: boolean;
  readonly textContent: string;
  readonly structuredContent?: Record<string, unknown>;
}

export interface Layer1Result {
  readonly passed: boolean;
  readonly toolSelected: boolean;
  readonly argsMatched: boolean;
  readonly toolOutputMatched: boolean;
  readonly numbersInProse: boolean;
  readonly missingNumbers: readonly number[];
  readonly failureReasons: readonly string[];
}

export interface RubricScore {
  readonly citationFaithfulness: number;
  readonly completeness: number;
  readonly clarity: number;
  readonly hallucinatedCitation: boolean;
  readonly rationale: string;
}

export interface CaseEvaluation {
  readonly id: string;
  readonly prompt: string;
  readonly expectedTool: ToolName;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalAnswer: string;
  readonly layer1: Layer1Result;
  readonly layer2: RubricScore;
  readonly durationMs: number;
}

export interface GateThresholds {
  readonly minLayer1Passed: number;
  readonly minMeanRubricScore: number;
  readonly maxHallucinatedCitations: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  minLayer1Passed: 33,
  minMeanRubricScore: 4.0,
  maxHallucinatedCitations: 0,
};

export interface Scorecard {
  readonly generatedAt: string;
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly totalCases: number;
  readonly gatePassed: boolean;
  readonly gateFailures: readonly string[];
  readonly thresholds: GateThresholds;
  readonly layer1Summary: {
    readonly passed: number;
    readonly total: number;
    readonly passRate: number;
    readonly toolSelectionPassed: number;
    readonly argsMatchedPassed: number;
    readonly toolOutputMatchedPassed: number;
    readonly numbersInProsePassed: number;
  };
  readonly layer2Summary: {
    readonly meanCitationFaithfulness: number;
    readonly meanCompleteness: number;
    readonly meanClarity: number;
    readonly overallMean: number;
    readonly hallucinatedCitations: number;
  };
  readonly cases: readonly CaseEvaluation[];
}

/** Parses evals/cases.jsonl into prompt entries. */
export function parseCasesJsonl(jsonlText: string): EvalPromptEntry[] {
  const lines = jsonlText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`cases.jsonl:${index + 1}: expected a JSON object.`);
    }
    const { id, prompt } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`cases.jsonl:${index + 1}: missing non-empty string "id".`);
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error(`cases.jsonl:${index + 1}: missing non-empty string "prompt".`);
    }
    return { id, prompt };
  });
}

/** Pairs every golden case in test/golden/cases.json with its natural-language prompt. */
export function buildEvalSpecs(
  golden: GoldenFile,
  prompts: readonly EvalPromptEntry[],
): EvalSpec[] {
  const goldenById = new Map<string, { tool: ToolName; entry: GoldenCaseEntry }>();
  const register = (tool: ToolName, entries: readonly GoldenCaseEntry[]) => {
    for (const entry of entries) {
      goldenById.set(entry.id, { tool, entry });
    }
  };
  register("calculate_epf", golden.epf);
  register("calculate_socso_eis", golden.socsoEis);
  register("calculate_mtd", golden.mtd);
  register("calculate_net_pay", golden.netPay);

  const seenIds = new Set<string>();
  const specs: EvalSpec[] = [];

  for (const item of prompts) {
    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate eval case ID "${item.id}" in cases.jsonl.`);
    }
    seenIds.add(item.id);

    const match = goldenById.get(item.id);
    if (match === undefined) {
      throw new Error(`Eval case "${item.id}" does not exist in test/golden/cases.json.`);
    }

    specs.push({
      id: item.id,
      prompt: item.prompt,
      expectedTool: match.tool,
      expectedInput: match.entry.input,
      ...(match.entry.expected !== undefined ? { expectedOutput: match.entry.expected } : {}),
      ...(match.entry.error !== undefined ? { expectedError: match.entry.error } : {}),
    });
  }

  for (const id of goldenById.keys()) {
    if (!seenIds.has(id)) {
      throw new Error(`Golden case "${id}" has no prompt in evals/cases.jsonl.`);
    }
  }

  return specs;
}

/** Loads eval specs from disk using the repo's golden cases and evals/cases.jsonl. */
export function loadEvalSpecs(
  casesJsonlUrl = new URL("./cases.jsonl", import.meta.url),
  goldenJsonUrl = new URL("../test/golden/cases.json", import.meta.url),
): EvalSpec[] {
  const jsonlText = readFileSync(casesJsonlUrl, "utf8");
  const golden = JSON.parse(readFileSync(goldenJsonUrl, "utf8")) as GoldenFile;
  return buildEvalSpecs(golden, parseCasesJsonl(jsonlText));
}

/**
 * Normalizes tool arguments by applying documented schema defaults and stripping fields the
 * tool schema documents as ignored (such as resident-only fields when `taxResident: false`).
 */
export function canonicalizeArgs(
  tool: ToolName,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rawArgs };

  if (tool === "calculate_epf" || tool === "calculate_net_pay") {
    out.registeredWithEpfBefore1Aug1998 = Boolean(out.registeredWithEpfBefore1Aug1998 ?? false);
  }

  if (tool === "calculate_socso_eis" || tool === "calculate_net_pay") {
    out.skbbkStatus = out.skbbkStatus ?? "covered";
    if (typeof out.age === "number" && (out.age < 57 || out.age > 59)) {
      delete out.eisPayableBefore57;
    }
  }

  if (tool === "calculate_mtd" || tool === "calculate_net_pay") {
    const taxResident = out.taxResident ?? true;
    out.taxResident = taxResident;

    if (taxResident === false) {
      delete out.taxCategory;
      delete out.children;
      delete out.tp1Reliefs;
      delete out.yearToDate;
    } else {
      out.children = out.children ?? 0;
      out.tp1Reliefs = out.tp1Reliefs ?? 0;
      const isJanuary = typeof out.payPeriod === "string" && out.payPeriod.endsWith("-01");
      if (isJanuary) {
        delete out.yearToDate;
      } else if (
        typeof out.yearToDate === "object" &&
        out.yearToDate !== null &&
        !Array.isArray(out.yearToDate)
      ) {
        const ytd = out.yearToDate as Record<string, unknown>;
        out.yearToDate = {
          ...ytd,
          tp1Reliefs: ytd.tp1Reliefs ?? 0,
        };
      }
    }
  }

  return sortObjectKeys(out);
}

function sortObjectKeys(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    sorted[key] =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? sortObjectKeys(entry)
        : entry;
  }
  return sorted;
}

/** Deep subset check: every key/value in `expected` must match `actual`. */
export function matchesExpectedObject(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }
  const record = actual as Record<string, unknown>;
  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = record[key];
    if (typeof expectedVal === "object" && expectedVal !== null && !Array.isArray(expectedVal)) {
      if (!matchesExpectedObject(actualVal, expectedVal as Record<string, unknown>)) {
        return false;
      }
    } else if (!Object.is(actualVal, expectedVal)) {
      return false;
    }
  }
  return true;
}

/**
 * Extracts the headline statutory RM figures from a golden case's `expected` object that must
 * appear in the agent's final natural-language answer.
 */
export function headlineNumbers(spec: EvalSpec): number[] {
  const expected = spec.expectedOutput;
  if (expected === undefined) return [];

  const nums: number[] = [];
  const pushNum = (val: unknown) => {
    if (typeof val === "number" && !nums.includes(val)) {
      nums.push(val);
    }
  };

  switch (spec.expectedTool) {
    case "calculate_epf": {
      pushNum(expected.employer);
      pushNum(expected.employee);
      break;
    }
    case "calculate_socso_eis": {
      const socso = expected.socso as Record<string, unknown> | undefined;
      if (socso !== undefined) {
        pushNum(socso.employer);
        pushNum(socso.employee);
      }
      const skbbk = expected.skbbk as Record<string, unknown> | undefined;
      if (skbbk !== undefined) {
        pushNum(skbbk.employee);
      }
      const eis = expected.eis as Record<string, unknown> | undefined;
      if (eis !== undefined) {
        pushNum(eis.employer);
        pushNum(eis.employee);
      }
      break;
    }
    case "calculate_mtd": {
      pushNum(expected.mtd);
      break;
    }
    case "calculate_net_pay": {
      pushNum(expected.netPay);
      const deductions = expected.deductions as Record<string, unknown> | undefined;
      if (deductions !== undefined) {
        pushNum(deductions.epf);
        pushNum(deductions.socso);
        pushNum(deductions.skbbk);
        pushNum(deductions.eis);
        pushNum(deductions.mtd);
        pushNum(deductions.total);
      }
      break;
    }
  }

  return nums;
}

const NUMBER_TOKEN_RE = /\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b/g;
const ZERO_WORD_RE = /\b(?:nil|exempt|none|nothing|zero)\b/i;

/**
 * Checks whether a statutory RM figure appears in natural-language prose, matching formatted
 * numbers (`3,000`, `3,000.00`, `3000`, `5.90`, `5.9`) by numeric value rather than substring.
 */
export function containsRmAmount(prose: string, amount: number): boolean {
  const matches = prose.match(NUMBER_TOKEN_RE) ?? [];
  for (const token of matches) {
    const parsed = Number(token.replaceAll(",", ""));
    if (Math.abs(parsed - amount) < 1e-6) {
      return true;
    }
  }
  if (amount === 0 && ZERO_WORD_RE.test(prose)) {
    return true;
  }
  return false;
}

const OPT_OUT_REFUSAL_RE =
  /opt[\s-]*out|cannot|can't|not\s+allowed|mandatory|not\s+eligible|not\s+permitted/i;

/** Evaluates Layer 1 (deterministic tool selection, argument extraction and statutory numbers). */
export function evaluateLayer1(
  spec: EvalSpec,
  toolCalls: readonly RecordedToolCall[],
  finalAnswer: string,
): Layer1Result {
  const failureReasons: string[] = [];

  if (spec.expectedError !== undefined) {
    const matchingCall = toolCalls.find((call) => call.name === spec.expectedTool);
    const toolSelected = matchingCall !== undefined || toolCalls.length === 0;
    if (!toolSelected) {
      failureReasons.push(
        `Expected tool "${spec.expectedTool}" or direct refusal, got: ${toolCalls.map((c) => c.name).join(", ")}.`,
      );
    }

    let argsMatched = true;
    let toolOutputMatched = true;
    if (matchingCall !== undefined) {
      const expectedCanonical = canonicalizeArgs(spec.expectedTool, spec.expectedInput);
      const expectedCoveredCanonical = canonicalizeArgs(spec.expectedTool, {
        ...spec.expectedInput,
        skbbkStatus: "covered",
      });
      const actualCanonical = canonicalizeArgs(spec.expectedTool, matchingCall.arguments);
      argsMatched =
        JSON.stringify(actualCanonical) === JSON.stringify(expectedCanonical) ||
        JSON.stringify(actualCanonical) === JSON.stringify(expectedCoveredCanonical);
      if (!argsMatched) {
        failureReasons.push(
          `Tool arguments ${JSON.stringify(actualCanonical)} did not match expected ${JSON.stringify(expectedCanonical)}.`,
        );
      }
      if (
        matchingCall.arguments.skbbkStatus === "opted_out" &&
        (!matchingCall.isError || !matchingCall.textContent.includes(spec.expectedError))
      ) {
        toolOutputMatched = false;
        failureReasons.push(`Expected tool error containing "${spec.expectedError}".`);
      }
    }

    const mentionsSkbbk = /skbbk|lindung\s*24\s*jam/i.test(finalAnswer);
    const explainsRefusal = OPT_OUT_REFUSAL_RE.test(finalAnswer);
    const numbersInProse = mentionsSkbbk && explainsRefusal;
    if (!numbersInProse) {
      failureReasons.push(
        "Final answer did not clearly explain that foreign workers cannot opt out of SKBBK.",
      );
    }

    return {
      passed: toolSelected && argsMatched && toolOutputMatched && numbersInProse,
      toolSelected,
      argsMatched,
      toolOutputMatched,
      numbersInProse,
      missingNumbers: [],
      failureReasons,
    };
  }

  const matchingCall = toolCalls.find((call) => call.name === spec.expectedTool);
  const toolSelected = matchingCall !== undefined && toolCalls.length === 1;
  if (!toolSelected) {
    const called = toolCalls.length === 0 ? "none" : toolCalls.map((c) => c.name).join(", ");
    failureReasons.push(`Expected single tool call to "${spec.expectedTool}", got: ${called}.`);
  }

  let argsMatched = false;
  let toolOutputMatched = false;

  if (matchingCall !== undefined) {
    const expectedCanonical = canonicalizeArgs(spec.expectedTool, spec.expectedInput);
    const actualCanonical = canonicalizeArgs(spec.expectedTool, matchingCall.arguments);
    argsMatched = JSON.stringify(actualCanonical) === JSON.stringify(expectedCanonical);
    if (!argsMatched) {
      failureReasons.push(
        `Arguments mismatch: expected ${JSON.stringify(expectedCanonical)}, got ${JSON.stringify(actualCanonical)}.`,
      );
    }

    if (matchingCall.isError || matchingCall.structuredContent === undefined) {
      toolOutputMatched = false;
      failureReasons.push(`Tool call returned error: ${matchingCall.textContent}`);
    } else if (spec.expectedOutput !== undefined) {
      toolOutputMatched = matchesExpectedObject(
        matchingCall.structuredContent,
        spec.expectedOutput,
      );
      if (!toolOutputMatched) {
        failureReasons.push("Tool structuredContent did not match golden expected output.");
      }
    } else {
      toolOutputMatched = true;
    }
  }

  const requiredNumbers = headlineNumbers(spec);
  const missingNumbers = requiredNumbers.filter((num) => !containsRmAmount(finalAnswer, num));
  const numbersInProse = missingNumbers.length === 0;
  if (!numbersInProse) {
    failureReasons.push(
      `Final answer missing expected RM amounts: ${missingNumbers.map((n) => n.toFixed(2)).join(", ")}.`,
    );
  }

  return {
    passed: toolSelected && argsMatched && toolOutputMatched && numbersInProse,
    toolSelected,
    argsMatched,
    toolOutputMatched,
    numbersInProse,
    missingNumbers,
    failureReasons,
  };
}

/** Parses and validates the JSON response returned by the LLM judge. */
export function parseJudgeResponse(rawText: string): RubricScore {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Judge response did not contain a JSON object: ${rawText}`);
  }

  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Judge JSON must be an object.");
  }

  const record = parsed as Record<string, unknown>;
  const citationFaithfulness = scoreField(record, "citationFaithfulness");
  const completeness = scoreField(record, "completeness");
  const clarity = scoreField(record, "clarity");
  if (typeof record.hallucinatedCitation !== "boolean") {
    throw new Error('Judge JSON field "hallucinatedCitation" must be a boolean.');
  }
  if (typeof record.rationale !== "string" || record.rationale.trim() === "") {
    throw new Error('Judge JSON field "rationale" must be a non-empty string.');
  }

  return {
    citationFaithfulness,
    completeness,
    clarity,
    hallucinatedCitation: record.hallucinatedCitation || citationFaithfulness < 3,
    rationale: record.rationale.trim(),
  };
}

function scoreField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`Judge JSON field "${field}" must be an integer from 1 to 5.`);
  }
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Aggregates per-case results into a suite scorecard and evaluates the dual CI gate. */
export function buildScorecard(params: {
  readonly cases: readonly CaseEvaluation[];
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly thresholds?: GateThresholds;
  readonly generatedAt?: string;
}): Scorecard {
  const thresholds = params.thresholds ?? DEFAULT_THRESHOLDS;
  const total = params.cases.length;

  const passed = params.cases.filter((c) => c.layer1.passed).length;
  const toolSelectionPassed = params.cases.filter((c) => c.layer1.toolSelected).length;
  const argsMatchedPassed = params.cases.filter((c) => c.layer1.argsMatched).length;
  const toolOutputMatchedPassed = params.cases.filter((c) => c.layer1.toolOutputMatched).length;
  const numbersInProsePassed = params.cases.filter((c) => c.layer1.numbersInProse).length;

  const meanCitationFaithfulness =
    total === 0
      ? 0
      : round2(params.cases.reduce((sum, c) => sum + c.layer2.citationFaithfulness, 0) / total);
  const meanCompleteness =
    total === 0
      ? 0
      : round2(params.cases.reduce((sum, c) => sum + c.layer2.completeness, 0) / total);
  const meanClarity =
    total === 0 ? 0 : round2(params.cases.reduce((sum, c) => sum + c.layer2.clarity, 0) / total);
  const overallMean =
    total === 0 ? 0 : round2((meanCitationFaithfulness + meanCompleteness + meanClarity) / 3);
  const hallucinatedCitations = params.cases.filter((c) => c.layer2.hallucinatedCitation).length;

  const gateFailures: string[] = [];
  if (passed < thresholds.minLayer1Passed) {
    gateFailures.push(
      `Layer 1 deterministic pass count ${passed}/${total} is below threshold ${thresholds.minLayer1Passed}/${total}.`,
    );
  }
  if (overallMean < thresholds.minMeanRubricScore) {
    gateFailures.push(
      `Layer 2 mean rubric score ${overallMean.toFixed(2)}/5.00 is below threshold ${thresholds.minMeanRubricScore.toFixed(2)}/5.00.`,
    );
  }
  if (hallucinatedCitations > thresholds.maxHallucinatedCitations) {
    gateFailures.push(
      `Layer 2 detected ${hallucinatedCitations} case(s) with hallucinated citations (max allowed: ${thresholds.maxHallucinatedCitations}).`,
    );
  }

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    agentModel: params.agentModel,
    judgeModel: params.judgeModel,
    totalCases: total,
    gatePassed: gateFailures.length === 0,
    gateFailures,
    thresholds,
    layer1Summary: {
      passed,
      total,
      passRate: total === 0 ? 0 : round2((passed / total) * 100),
      toolSelectionPassed,
      argsMatchedPassed,
      toolOutputMatchedPassed,
      numbersInProsePassed,
    },
    layer2Summary: {
      meanCitationFaithfulness,
      meanCompleteness,
      meanClarity,
      overallMean,
      hallucinatedCitations,
    },
    cases: params.cases,
  };
}

/** Renders the scorecard as a Markdown report for CI job summaries and artifacts. */
export function renderScorecardMarkdown(scorecard: Scorecard): string {
  const status = scorecard.gatePassed ? "PASS" : "FAIL";
  const l1 = scorecard.layer1Summary;
  const l2 = scorecard.layer2Summary;

  const lines: string[] = [
    `# Malaysia Payroll MCP — Agent Eval Scorecard (${status})`,
    "",
    `- **Generated at**: \`${scorecard.generatedAt}\``,
    `- **Agent model**: \`${scorecard.agentModel}\``,
    `- **Judge model**: \`${scorecard.judgeModel}\``,
    `- **Total cases**: ${scorecard.totalCases}`,
    `- **CI Gate**: **${status}** (thresholds: Layer 1 >= ${scorecard.thresholds.minLayer1Passed}/${scorecard.totalCases}, Layer 2 mean >= ${scorecard.thresholds.minMeanRubricScore.toFixed(2)}/5.00, hallucinated citations <= ${scorecard.thresholds.maxHallucinatedCitations})`,
    "",
  ];

  if (scorecard.gateFailures.length > 0) {
    lines.push("## Gate Failures", "");
    for (const failure of scorecard.gateFailures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }

  lines.push(
    "## Layer 1: Deterministic Tool-Use Summary",
    "",
    "| Check | Passed | Total | Rate |",
    "| --- | --- | --- | --- |",
    `| Tool selection | ${l1.toolSelectionPassed} | ${l1.total} | ${rateStr(l1.toolSelectionPassed, l1.total)} |`,
    `| Schema arguments | ${l1.argsMatchedPassed} | ${l1.total} | ${rateStr(l1.argsMatchedPassed, l1.total)} |`,
    `| Tool structured output | ${l1.toolOutputMatchedPassed} | ${l1.total} | ${rateStr(l1.toolOutputMatchedPassed, l1.total)} |`,
    `| Exact statutory numbers in prose | ${l1.numbersInProsePassed} | ${l1.total} | ${rateStr(l1.numbersInProsePassed, l1.total)} |`,
    `| **Overall Layer 1** | **${l1.passed}** | **${l1.total}** | **${l1.passRate.toFixed(1)}%** |`,
    "",
    "## Layer 2: Model-Based Rubric Summary (1–5)",
    "",
    "| Dimension | Mean Score |",
    "| --- | --- |",
    `| Citation faithfulness | ${l2.meanCitationFaithfulness.toFixed(2)} / 5.00 |`,
    `| Completeness | ${l2.meanCompleteness.toFixed(2)} / 5.00 |`,
    `| Clarity | ${l2.meanClarity.toFixed(2)} / 5.00 |`,
    `| **Overall Mean** | **${l2.overallMean.toFixed(2)} / 5.00** |`,
    `| Hallucinated citations | ${l2.hallucinatedCitations} |`,
    "",
    "## Per-Case Breakdown",
    "",
    "| ID | Tool | Layer 1 | Cite | Comp | Clar | Hallucinated | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const c of scorecard.cases) {
    const l1Badge = c.layer1.passed ? "PASS" : "FAIL";
    const hallucinated = c.layer2.hallucinatedCitation ? "YES" : "no";
    const note =
      c.layer1.failureReasons.length > 0
        ? `${c.layer1.failureReasons.join(" ")} | ${c.layer2.rationale}`
        : c.layer2.rationale;
    const escapedNote = note.replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(
      `| ${c.id} | \`${c.expectedTool}\` | ${l1Badge} | ${c.layer2.citationFaithfulness} | ${c.layer2.completeness} | ${c.layer2.clarity} | ${hallucinated} | ${escapedNote} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function rateStr(passed: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((passed / total) * 100).toFixed(1)}%`;
}
