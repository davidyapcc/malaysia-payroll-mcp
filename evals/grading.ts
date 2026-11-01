// Pure grading, canonicalization and scorecard formatting for the two-layer agent eval (ADR 0004).
import * as z from "zod";

export type ToolName =
  | "calculate_epf"
  | "calculate_socso_eis"
  | "calculate_mtd"
  | "calculate_net_pay";

export const MIN_RUBRIC_SCORE = 1;
export const MAX_RUBRIC_SCORE = 5;
export const FAITHFUL_CITATION_FLOOR = 3;

const AMOUNT_TOLERANCE = 1e-6;
const PERCENT_SCALE = 100;
const RUBRIC_DIMENSION_COUNT = 3;
const EIS_AGE_MIN = 57;
const EIS_AGE_MAX = 59;

const evalPromptSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

const goldenCaseSchema = z.object({
  id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()).optional(),
  error: z.string().min(1).optional(),
});

export const goldenFileSchema = z.object({
  epf: z.array(goldenCaseSchema),
  socsoEis: z.array(goldenCaseSchema),
  mtd: z.array(goldenCaseSchema),
  netPay: z.array(goldenCaseSchema),
});

const rubricDimensionSchema = z.number().int().min(MIN_RUBRIC_SCORE).max(MAX_RUBRIC_SCORE);

const judgeResponseSchema = z.object({
  citationFaithfulness: rubricDimensionSchema,
  completeness: rubricDimensionSchema,
  clarity: rubricDimensionSchema,
  hallucinatedCitation: z.boolean(),
  rationale: z.string().trim().min(1),
});

export type EvalPromptEntry = z.infer<typeof evalPromptSchema>;
export type GoldenCaseEntry = z.infer<typeof goldenCaseSchema>;
export type GoldenFile = z.infer<typeof goldenFileSchema>;

export interface EvalCase {
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
  readonly isPassed: boolean;
  readonly hasExpectedTool: boolean;
  readonly hasMatchingArgs: boolean;
  readonly hasMatchingToolOutput: boolean;
  readonly hasExpectedProseAmounts: boolean;
  readonly missingAmounts: readonly number[];
  readonly failureReasons: readonly string[];
}

export interface RubricScore {
  readonly citationFaithfulness: number;
  readonly completeness: number;
  readonly clarity: number;
  readonly hasHallucinatedCitation: boolean;
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
  readonly isGatePassed: boolean;
  readonly gateFailures: readonly string[];
  readonly thresholds: GateThresholds;
  readonly layer1Summary: {
    readonly passed: number;
    readonly total: number;
    readonly passRate: number;
    readonly toolSelectionPassed: number;
    readonly argsMatchedPassed: number;
    readonly toolOutputMatchedPassed: number;
    readonly proseAmountsPassed: number;
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

/** Parses evals/cases.jsonl into validated prompt entries. */
export function parseCasesJsonl(jsonlText: string): EvalPromptEntry[] {
  const lines = jsonlText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => {
    const parsed: unknown = JSON.parse(line);
    const result = evalPromptSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`cases.jsonl:${index + 1}: ${result.error.message}`);
    }
    return result.data;
  });
}

/** Pairs every golden case in test/golden/cases.json with its natural-language eval case. */
export function buildEvalCases(
  golden: GoldenFile,
  prompts: readonly EvalPromptEntry[],
): EvalCase[] {
  const goldenById = indexGoldenCases(golden);
  const seenIds = new Set<string>();
  const evalCases: EvalCase[] = [];

  for (const item of prompts) {
    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate eval case ID "${item.id}" in cases.jsonl.`);
    }
    seenIds.add(item.id);
    const match = goldenById.get(item.id);
    if (match === undefined) {
      throw new Error(`Eval case "${item.id}" does not exist in test/golden/cases.json.`);
    }
    evalCases.push({
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
  return evalCases;
}

function indexGoldenCases(
  golden: GoldenFile,
): Map<string, { tool: ToolName; entry: GoldenCaseEntry }> {
  const map = new Map<string, { tool: ToolName; entry: GoldenCaseEntry }>();
  const groups: readonly [ToolName, readonly GoldenCaseEntry[]][] = [
    ["calculate_epf", golden.epf],
    ["calculate_socso_eis", golden.socsoEis],
    ["calculate_mtd", golden.mtd],
    ["calculate_net_pay", golden.netPay],
  ];
  for (const [tool, entries] of groups) {
    for (const entry of entries) {
      map.set(entry.id, { tool, entry });
    }
  }
  return map;
}

/**
 * Normalizes tool arguments by applying documented schema defaults and omitting fields the
 * tool schema documents as ignored (such as resident-only fields when `taxResident: false`).
 */
export function canonicalizeArgs(
  tool: ToolName,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const omitKeys = new Set<string>();
  const extra: Record<string, unknown> = {};

  if (tool === "calculate_epf" || tool === "calculate_net_pay") {
    extra.registeredWithEpfBefore1Aug1998 = Boolean(
      rawArgs.registeredWithEpfBefore1Aug1998 ?? false,
    );
  }
  if (tool === "calculate_socso_eis" || tool === "calculate_net_pay") {
    extra.skbbkStatus = rawArgs.skbbkStatus ?? "covered";
    if (
      typeof rawArgs.age === "number" &&
      (rawArgs.age < EIS_AGE_MIN || rawArgs.age > EIS_AGE_MAX)
    ) {
      omitKeys.add("eisPayableBefore57");
    }
  }
  if (tool === "calculate_mtd" || tool === "calculate_net_pay") {
    applyMtdDefaults(rawArgs, extra, omitKeys);
  }

  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...rawArgs, ...extra })) {
    if (!omitKeys.has(key) && value !== undefined) {
      merged[key] = value;
    }
  }
  return sortObjectKeys(merged);
}

function applyMtdDefaults(
  rawArgs: Record<string, unknown>,
  extra: Record<string, unknown>,
  omitKeys: Set<string>,
): void {
  const taxResident = rawArgs.taxResident ?? true;
  extra.taxResident = taxResident;

  if (taxResident === false) {
    for (const key of ["taxCategory", "children", "tp1Reliefs", "yearToDate"]) {
      omitKeys.add(key);
    }
    return;
  }

  extra.children = rawArgs.children ?? 0;
  extra.tp1Reliefs = rawArgs.tp1Reliefs ?? 0;
  const isJanuary = typeof rawArgs.payPeriod === "string" && rawArgs.payPeriod.endsWith("-01");
  if (isJanuary) {
    omitKeys.add("yearToDate");
  } else if (isPlainObject(rawArgs.yearToDate)) {
    extra.yearToDate = {
      ...rawArgs.yearToDate,
      tp1Reliefs: rawArgs.yearToDate.tp1Reliefs ?? 0,
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortObjectKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    sorted[key] = isPlainObject(entry) ? sortObjectKeys(entry) : entry;
  }
  return sorted;
}

function pickField(obj: unknown, key: string): unknown {
  return isPlainObject(obj) ? obj[key] : undefined;
}

/** Deep subset check: every key/value in `expected` must match `actual`. */
export function matchesExpectedObject(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!isPlainObject(actual)) return false;
  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = actual[key];
    if (isPlainObject(expectedVal)) {
      if (!matchesExpectedObject(actualVal, expectedVal)) return false;
    } else if (!Object.is(actualVal, expectedVal)) {
      return false;
    }
  }
  return true;
}

/**
 * Extracts every headline statutory RM figure from a golden case's `expected` object that must
 * appear in the agent's final natural-language answer.
 */
export function headlineNumbers(evalCase: EvalCase): number[] {
  const expected = evalCase.expectedOutput;
  if (expected === undefined) return [];

  const nums: number[] = [];
  const pushAll = (values: readonly unknown[]) => {
    for (const val of values) {
      if (typeof val === "number" && !nums.includes(val)) nums.push(val);
    }
  };

  if (evalCase.expectedTool === "calculate_epf") {
    pushAll([expected.employer, expected.employee, expected.total]);
  } else if (evalCase.expectedTool === "calculate_socso_eis") {
    pushAll([
      pickField(expected.socso, "employer"),
      pickField(expected.socso, "employee"),
      pickField(expected.skbbk, "employee"),
      pickField(expected.eis, "employer"),
      pickField(expected.eis, "employee"),
    ]);
  } else if (evalCase.expectedTool === "calculate_mtd") {
    pushAll([expected.mtd]);
  } else {
    const ded = expected.deductions;
    const er = expected.employerContributions;
    pushAll([
      expected.netPay,
      pickField(ded, "epf"),
      pickField(ded, "socso"),
      pickField(ded, "skbbk"),
      pickField(ded, "eis"),
      pickField(ded, "mtd"),
      pickField(ded, "total"),
      pickField(er, "epf"),
      pickField(er, "socso"),
      pickField(er, "eis"),
      pickField(er, "total"),
      expected.employerCost,
    ]);
  }
  return nums;
}

const RM_PREFIXED_RE = /(?:RM|MYR)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d%]|\.\d)/gi;
const DECIMAL_MONEY_RE = /(?<![.\d-])(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d%]|\.\d)/g;
const ZERO_WORD_RE = /\b(?:nil|exempt)\b/i;

/**
 * Checks whether a statutory RM figure appears in natural-language prose, matching RM-prefixed
 * (`RM550.00`, `RM 3,000`) or 2-decimal (`550.00`) amounts without matching ages, years or rates.
 */
export function containsRmAmount(prose: string, amount: number): boolean {
  for (const regex of [RM_PREFIXED_RE, DECIMAL_MONEY_RE]) {
    for (const match of prose.matchAll(regex)) {
      const token = match[0].replace(/^(?:RM|MYR)\s*/i, "").replaceAll(",", "");
      if (Math.abs(Number(token) - amount) < AMOUNT_TOLERANCE) {
        return true;
      }
    }
  }
  return amount === 0 && ZERO_WORD_RE.test(prose);
}

const OPT_OUT_REFUSAL_RE =
  /opt[\s-]*out|cannot|can't|not\s+allowed|mandatory|not\s+eligible|not\s+permitted/i;

/** Evaluates Layer 1 (deterministic tool selection, argument extraction and statutory numbers). */
export function evaluateLayer1(
  evalCase: EvalCase,
  toolCalls: readonly RecordedToolCall[],
  finalAnswer: string,
): Layer1Result {
  const failureReasons: string[] = [];
  const matchingCall = toolCalls.find((call) => call.name === evalCase.expectedTool);
  const hasExpectedTool = matchingCall !== undefined && toolCalls.length === 1;
  if (!hasExpectedTool) {
    const called = toolCalls.length === 0 ? "none" : toolCalls.map((c) => c.name).join(", ");
    failureReasons.push(`Expected single tool call to "${evalCase.expectedTool}", got: ${called}.`);
  }

  const hasMatchingArgs = checkArgsMatch(evalCase, matchingCall, failureReasons);
  const hasMatchingToolOutput = checkToolOutputMatch(evalCase, matchingCall, failureReasons);
  const { hasExpectedProseAmounts, missingAmounts } = checkProseMatch(
    evalCase,
    finalAnswer,
    failureReasons,
  );

  return {
    isPassed:
      hasExpectedTool && hasMatchingArgs && hasMatchingToolOutput && hasExpectedProseAmounts,
    hasExpectedTool,
    hasMatchingArgs,
    hasMatchingToolOutput,
    hasExpectedProseAmounts,
    missingAmounts,
    failureReasons,
  };
}

function checkArgsMatch(
  evalCase: EvalCase,
  matchingCall: RecordedToolCall | undefined,
  failureReasons: string[],
): boolean {
  if (matchingCall === undefined) return false;
  const expectedCanonical = canonicalizeArgs(evalCase.expectedTool, evalCase.expectedInput);
  const actualCanonical = canonicalizeArgs(evalCase.expectedTool, matchingCall.arguments);
  const matched = JSON.stringify(actualCanonical) === JSON.stringify(expectedCanonical);
  if (!matched) {
    failureReasons.push(
      `Arguments mismatch: expected ${JSON.stringify(expectedCanonical)}, got ${JSON.stringify(actualCanonical)}.`,
    );
  }
  return matched;
}

function checkToolOutputMatch(
  evalCase: EvalCase,
  matchingCall: RecordedToolCall | undefined,
  failureReasons: string[],
): boolean {
  if (matchingCall === undefined) return false;
  if (evalCase.expectedError !== undefined) {
    const matched =
      matchingCall.isError && matchingCall.textContent.includes(evalCase.expectedError);
    if (!matched) {
      failureReasons.push(`Expected tool error containing "${evalCase.expectedError}".`);
    }
    return matched;
  }
  if (matchingCall.isError || matchingCall.structuredContent === undefined) {
    failureReasons.push(`Tool call returned error: ${matchingCall.textContent}`);
    return false;
  }
  if (
    evalCase.expectedOutput !== undefined &&
    !matchesExpectedObject(matchingCall.structuredContent, evalCase.expectedOutput)
  ) {
    failureReasons.push("Tool structuredContent did not match golden expected output.");
    return false;
  }
  return true;
}

function checkProseMatch(
  evalCase: EvalCase,
  finalAnswer: string,
  failureReasons: string[],
): { hasExpectedProseAmounts: boolean; missingAmounts: number[] } {
  if (evalCase.expectedError !== undefined) {
    const hasExpectedProseAmounts =
      /skbbk|lindung\s*24\s*jam/i.test(finalAnswer) && OPT_OUT_REFUSAL_RE.test(finalAnswer);
    if (!hasExpectedProseAmounts) {
      failureReasons.push(
        "Final answer did not clearly explain that foreign workers cannot opt out of SKBBK.",
      );
    }
    return { hasExpectedProseAmounts, missingAmounts: [] };
  }

  const missingAmounts = headlineNumbers(evalCase).filter(
    (num) => !containsRmAmount(finalAnswer, num),
  );
  const hasExpectedProseAmounts = missingAmounts.length === 0;
  if (!hasExpectedProseAmounts) {
    failureReasons.push(
      `Final answer missing expected RM amounts: ${missingAmounts.map((n) => n.toFixed(2)).join(", ")}.`,
    );
  }
  return { hasExpectedProseAmounts, missingAmounts };
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
  const validated = judgeResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid judge JSON: ${validated.error.message}`);
  }

  const { citationFaithfulness, completeness, clarity, hallucinatedCitation, rationale } =
    validated.data;
  return {
    citationFaithfulness,
    completeness,
    clarity,
    hasHallucinatedCitation: hallucinatedCitation || citationFaithfulness < FAITHFUL_CITATION_FLOOR,
    rationale,
  };
}

function round2(value: number): number {
  return Math.round(value * PERCENT_SCALE) / PERCENT_SCALE;
}

function meanOf(cases: readonly CaseEvaluation[], pick: (c: CaseEvaluation) => number): number {
  if (cases.length === 0) return 0;
  return round2(cases.reduce((sum, c) => sum + pick(c), 0) / cases.length);
}

/** Aggregates per-case results into a suite scorecard and evaluates the dual CI gate. */
export function buildScorecard(params: {
  readonly cases: readonly CaseEvaluation[];
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly thresholds?: GateThresholds;
}): Scorecard {
  const thresholds = params.thresholds ?? DEFAULT_THRESHOLDS;
  const layer1Summary = summarizeLayer1(params.cases);
  const meanCitationFaithfulness = meanOf(params.cases, (c) => c.layer2.citationFaithfulness);
  const meanCompleteness = meanOf(params.cases, (c) => c.layer2.completeness);
  const meanClarity = meanOf(params.cases, (c) => c.layer2.clarity);
  const overallMean = round2(
    (meanCitationFaithfulness + meanCompleteness + meanClarity) / RUBRIC_DIMENSION_COUNT,
  );
  const hallucinatedCitations = params.cases.filter((c) => c.layer2.hasHallucinatedCitation).length;
  const gateFailures = collectGateFailures(
    layer1Summary.passed,
    layer1Summary.total,
    overallMean,
    hallucinatedCitations,
    thresholds,
  );

  return {
    generatedAt: new Date().toISOString(),
    agentModel: params.agentModel,
    judgeModel: params.judgeModel,
    totalCases: layer1Summary.total,
    isGatePassed: gateFailures.length === 0,
    gateFailures,
    thresholds,
    layer1Summary,
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

function summarizeLayer1(cases: readonly CaseEvaluation[]): Scorecard["layer1Summary"] {
  const total = cases.length;
  const passed = cases.filter((c) => c.layer1.isPassed).length;
  return {
    passed,
    total,
    passRate: total === 0 ? 0 : round2((passed / total) * PERCENT_SCALE),
    toolSelectionPassed: cases.filter((c) => c.layer1.hasExpectedTool).length,
    argsMatchedPassed: cases.filter((c) => c.layer1.hasMatchingArgs).length,
    toolOutputMatchedPassed: cases.filter((c) => c.layer1.hasMatchingToolOutput).length,
    proseAmountsPassed: cases.filter((c) => c.layer1.hasExpectedProseAmounts).length,
  };
}

function collectGateFailures(
  passed: number,
  total: number,
  overallMean: number,
  hallucinatedCitations: number,
  thresholds: GateThresholds,
): string[] {
  const failures: string[] = [];
  if (passed < thresholds.minLayer1Passed) {
    failures.push(
      `Layer 1 deterministic pass count ${passed}/${total} is below threshold ${thresholds.minLayer1Passed}/${total}.`,
    );
  }
  if (overallMean < thresholds.minMeanRubricScore) {
    failures.push(
      `Layer 2 mean rubric score ${overallMean.toFixed(2)}/${MAX_RUBRIC_SCORE.toFixed(2)} is below threshold ${thresholds.minMeanRubricScore.toFixed(2)}/${MAX_RUBRIC_SCORE.toFixed(2)}.`,
    );
  }
  if (hallucinatedCitations > thresholds.maxHallucinatedCitations) {
    failures.push(
      `Layer 2 detected ${hallucinatedCitations} case(s) with hallucinated citations (max allowed: ${thresholds.maxHallucinatedCitations}).`,
    );
  }
  return failures;
}

/** Renders the scorecard as a Markdown report for CI job summaries and artifacts. */
export function renderScorecardMarkdown(scorecard: Scorecard): string {
  const status = scorecard.isGatePassed ? "PASS" : "FAIL";
  const l1 = scorecard.layer1Summary;
  const l2 = scorecard.layer2Summary;
  const maxScore = MAX_RUBRIC_SCORE.toFixed(2);

  const lines: string[] = [
    `# Malaysia Payroll MCP — Agent Eval Scorecard (${status})`,
    "",
    `- **Generated at**: \`${scorecard.generatedAt}\``,
    `- **Agent model**: \`${scorecard.agentModel}\``,
    `- **Judge model**: \`${scorecard.judgeModel}\``,
    `- **Total cases**: ${scorecard.totalCases}`,
    `- **CI Gate**: **${status}** (thresholds: Layer 1 >= ${scorecard.thresholds.minLayer1Passed}/${scorecard.totalCases}, Layer 2 mean >= ${scorecard.thresholds.minMeanRubricScore.toFixed(2)}/${maxScore}, hallucinated citations <= ${scorecard.thresholds.maxHallucinatedCitations})`,
    "",
    ...(scorecard.gateFailures.length > 0
      ? ["## Gate Failures", "", ...scorecard.gateFailures.map((f) => `- ${f}`), ""]
      : []),
    "## Layer 1: Deterministic Tool-Use Summary",
    "",
    "| Check | Passed | Total | Rate |",
    "| --- | --- | --- | --- |",
    `| Tool selection | ${l1.toolSelectionPassed} | ${l1.total} | ${rateStr(l1.toolSelectionPassed, l1.total)} |`,
    `| Schema arguments | ${l1.argsMatchedPassed} | ${l1.total} | ${rateStr(l1.argsMatchedPassed, l1.total)} |`,
    `| Tool structured output | ${l1.toolOutputMatchedPassed} | ${l1.total} | ${rateStr(l1.toolOutputMatchedPassed, l1.total)} |`,
    `| Exact statutory numbers in prose | ${l1.proseAmountsPassed} | ${l1.total} | ${rateStr(l1.proseAmountsPassed, l1.total)} |`,
    `| **Overall Layer 1** | **${l1.passed}** | **${l1.total}** | **${l1.passRate.toFixed(1)}%** |`,
    "",
    `## Layer 2: Model-Based Rubric Summary (${MIN_RUBRIC_SCORE}–${MAX_RUBRIC_SCORE})`,
    "",
    "| Dimension | Mean Score |",
    "| --- | --- |",
    `| Citation faithfulness | ${l2.meanCitationFaithfulness.toFixed(2)} / ${maxScore} |`,
    `| Completeness | ${l2.meanCompleteness.toFixed(2)} / ${maxScore} |`,
    `| Clarity | ${l2.meanClarity.toFixed(2)} / ${maxScore} |`,
    `| **Overall Mean** | **${l2.overallMean.toFixed(2)} / ${maxScore}** |`,
    `| Hallucinated citations | ${l2.hallucinatedCitations} |`,
    "",
    "## Per-Case Breakdown",
    "",
    "| ID | Tool | Layer 1 | Cite | Comp | Clar | Hallucinated | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scorecard.cases.map(renderCaseRow),
    "",
  ];
  return lines.join("\n");
}

function renderCaseRow(c: CaseEvaluation): string {
  const l1Badge = c.layer1.isPassed ? "PASS" : "FAIL";
  const hallucinated = c.layer2.hasHallucinatedCitation ? "YES" : "no";
  const note =
    c.layer1.failureReasons.length > 0
      ? `${c.layer1.failureReasons.join(" ")} | ${c.layer2.rationale}`
      : c.layer2.rationale;
  const escapedNote = note.replaceAll("|", "\\|").replaceAll("\n", " ");
  return `| ${c.id} | \`${c.expectedTool}\` | ${l1Badge} | ${c.layer2.citationFaithfulness} | ${c.layer2.completeness} | ${c.layer2.clarity} | ${hallucinated} | ${escapedNote} |`;
}

function rateStr(passed: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((passed / total) * PERCENT_SCALE).toFixed(1)}%`;
}
