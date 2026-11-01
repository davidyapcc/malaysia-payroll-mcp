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

  for (const item of prompts) {
    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate eval case ID "${item.id}" in cases.jsonl.`);
    }
    seenIds.add(item.id);
  }

  const cases = prompts.map((item) => {
    const match = goldenById.get(item.id);
    if (match === undefined) {
      throw new Error(`Eval case "${item.id}" does not exist in test/golden/cases.json.`);
    }
    return {
      id: item.id,
      prompt: item.prompt,
      expectedTool: match.tool,
      expectedInput: match.entry.input,
      ...(match.entry.expected !== undefined ? { expectedOutput: match.entry.expected } : {}),
      ...(match.entry.error !== undefined ? { expectedError: match.entry.error } : {}),
    };
  });

  for (const id of goldenById.keys()) {
    if (!seenIds.has(id)) {
      throw new Error(`Golden case "${id}" has no prompt in evals/cases.jsonl.`);
    }
  }

  return cases;
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

interface MtdDefaults {
  readonly extra: Record<string, unknown>;
  readonly omitKeys: readonly string[];
}

function computeMtdDefaults(rawArgs: Record<string, unknown>): MtdDefaults {
  const taxResident = rawArgs.taxResident ?? true;
  if (taxResident === false) {
    return {
      extra: { taxResident: false },
      omitKeys: ["taxCategory", "children", "tp1Reliefs", "yearToDate"],
    };
  }

  const isJanuary = typeof rawArgs.payPeriod === "string" && rawArgs.payPeriod.endsWith("-01");
  const yearToDate = isPlainObject(rawArgs.yearToDate)
    ? { ...rawArgs.yearToDate, tp1Reliefs: rawArgs.yearToDate.tp1Reliefs ?? 0 }
    : undefined;

  return {
    extra: {
      taxResident: true,
      children: rawArgs.children ?? 0,
      tp1Reliefs: rawArgs.tp1Reliefs ?? 0,
      ...(yearToDate !== undefined ? { yearToDate } : {}),
    },
    omitKeys: isJanuary ? ["yearToDate"] : [],
  };
}

/**
 * Normalizes tool arguments by applying documented schema defaults and omitting fields the
 * tool schema documents as ignored (such as resident-only fields when `taxResident: false`).
 */
export function canonicalizeArgs(
  tool: ToolName,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const epfExtra =
    tool === "calculate_epf" || tool === "calculate_net_pay"
      ? {
          registeredWithEpfBefore1Aug1998: Boolean(
            rawArgs.registeredWithEpfBefore1Aug1998 ?? false,
          ),
        }
      : {};

  const isEisAgeOutOfRange =
    typeof rawArgs.age === "number" && (rawArgs.age < EIS_AGE_MIN || rawArgs.age > EIS_AGE_MAX);
  const socsoExtra =
    tool === "calculate_socso_eis" || tool === "calculate_net_pay"
      ? { skbbkStatus: rawArgs.skbbkStatus ?? "covered" }
      : {};
  const socsoOmit =
    (tool === "calculate_socso_eis" || tool === "calculate_net_pay") && isEisAgeOutOfRange
      ? ["eisPayableBefore57"]
      : [];

  const mtd =
    tool === "calculate_mtd" || tool === "calculate_net_pay"
      ? computeMtdDefaults(rawArgs)
      : { extra: {}, omitKeys: [] };

  const omitSet = new Set<string>([...socsoOmit, ...mtd.omitKeys]);
  const combined = { ...rawArgs, ...epfExtra, ...socsoExtra, ...mtd.extra };
  const filtered = Object.fromEntries(
    Object.entries(combined).filter(([key, value]) => !omitSet.has(key) && value !== undefined),
  );
  return sortObjectKeys(filtered);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

function uniqueNumbers(values: readonly unknown[]): number[] {
  const numbers = values.filter((v): v is number => typeof v === "number");
  return Array.from(new Set(numbers));
}

/**
 * Extracts every headline statutory RM figure from a golden case's `expected` object that must
 * appear in the agent's final natural-language answer.
 */
export function headlineNumbers(evalCase: EvalCase): number[] {
  const expected = evalCase.expectedOutput;
  if (expected === undefined) return [];

  if (evalCase.expectedTool === "calculate_epf") {
    return uniqueNumbers([expected.employer, expected.employee, expected.total]);
  }
  if (evalCase.expectedTool === "calculate_socso_eis") {
    return uniqueNumbers([
      pickField(expected.socso, "employer"),
      pickField(expected.socso, "employee"),
      pickField(expected.skbbk, "employee"),
      pickField(expected.eis, "employer"),
      pickField(expected.eis, "employee"),
    ]);
  }
  if (evalCase.expectedTool === "calculate_mtd") {
    return uniqueNumbers([expected.mtd]);
  }
  const ded = expected.deductions;
  const er = expected.employerContributions;
  return uniqueNumbers([
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

const RM_PREFIXED_RE = /(?:RM|MYR)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d%]|\.\d)/gi;
const DECIMAL_MONEY_RE = /(?<![.\d-])(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d%]|\.\d)/g;
const ZERO_WORD_RE = /(?<!\bnot\s+)\b(?:nil|exempt(?:ed)?|zero)\b/i;

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

const REFUSAL_EXPLANATION_RE =
  /(?:cannot|can't|not\s+(?:allowed|permitted|eligible|possible)|unable|prohibited)\b[^.\n]*\bopt[\s-]*out|opt[\s-]*out\b[^.\n]*\b(?:not\s+(?:allowed|permitted|eligible|possible)|prohibited)|\bmandatory\b/i;
const AFFIRMATIVE_OPT_OUT_RE =
  /(?<!\bnot\s+)\b(?:can|may|allowed\s+to|permitted\s+to|eligible\s+to)\s+opt[\s-]*out\b/i;

/** Evaluates Layer 1 (deterministic tool selection, argument extraction and statutory numbers). */
export function evaluateLayer1(
  evalCase: EvalCase,
  toolCalls: readonly RecordedToolCall[],
  finalAnswer: string,
): Layer1Result {
  const matchingCall = toolCalls.find((call) => call.name === evalCase.expectedTool);
  const hasExpectedTool = matchingCall !== undefined && toolCalls.length === 1;
  const toolErrors = hasExpectedTool
    ? []
    : [
        `Expected single tool call to "${evalCase.expectedTool}", got: ${
          toolCalls.length === 0 ? "none" : toolCalls.map((c) => c.name).join(", ")
        }.`,
      ];

  const argsCheck = checkArgsMatch(evalCase, matchingCall);
  const toolOutputCheck = checkToolOutputMatch(evalCase, matchingCall);
  const proseCheck = checkProseMatch(evalCase, finalAnswer);

  const failureReasons = [
    ...toolErrors,
    ...argsCheck.failureReasons,
    ...toolOutputCheck.failureReasons,
    ...proseCheck.failureReasons,
  ];

  return {
    isPassed:
      hasExpectedTool &&
      argsCheck.hasMatchingArgs &&
      toolOutputCheck.hasMatchingToolOutput &&
      proseCheck.hasExpectedProseAmounts,
    hasExpectedTool,
    hasMatchingArgs: argsCheck.hasMatchingArgs,
    hasMatchingToolOutput: toolOutputCheck.hasMatchingToolOutput,
    hasExpectedProseAmounts: proseCheck.hasExpectedProseAmounts,
    missingAmounts: proseCheck.missingAmounts,
    failureReasons,
  };
}

function checkArgsMatch(
  evalCase: EvalCase,
  matchingCall: RecordedToolCall | undefined,
): { hasMatchingArgs: boolean; failureReasons: readonly string[] } {
  if (matchingCall === undefined) return { hasMatchingArgs: false, failureReasons: [] };
  const expectedCanonical = canonicalizeArgs(evalCase.expectedTool, evalCase.expectedInput);
  const actualCanonical = canonicalizeArgs(evalCase.expectedTool, matchingCall.arguments);
  const matched = JSON.stringify(actualCanonical) === JSON.stringify(expectedCanonical);
  return {
    hasMatchingArgs: matched,
    failureReasons: matched
      ? []
      : [
          `Arguments mismatch: expected ${JSON.stringify(expectedCanonical)}, got ${JSON.stringify(actualCanonical)}.`,
        ],
  };
}

function checkToolOutputMatch(
  evalCase: EvalCase,
  matchingCall: RecordedToolCall | undefined,
): { hasMatchingToolOutput: boolean; failureReasons: readonly string[] } {
  if (matchingCall === undefined) return { hasMatchingToolOutput: false, failureReasons: [] };
  if (evalCase.expectedError !== undefined) {
    const matched =
      matchingCall.isError && matchingCall.textContent.includes(evalCase.expectedError);
    return {
      hasMatchingToolOutput: matched,
      failureReasons: matched
        ? []
        : [`Expected tool error containing "${evalCase.expectedError}".`],
    };
  }
  if (matchingCall.isError || matchingCall.structuredContent === undefined) {
    return {
      hasMatchingToolOutput: false,
      failureReasons: [`Tool call returned error: ${matchingCall.textContent}`],
    };
  }
  if (
    evalCase.expectedOutput !== undefined &&
    !matchesExpectedObject(matchingCall.structuredContent, evalCase.expectedOutput)
  ) {
    return {
      hasMatchingToolOutput: false,
      failureReasons: ["Tool structuredContent did not match golden expected output."],
    };
  }
  return { hasMatchingToolOutput: true, failureReasons: [] };
}

function checkProseMatch(
  evalCase: EvalCase,
  finalAnswer: string,
): {
  hasExpectedProseAmounts: boolean;
  missingAmounts: readonly number[];
  failureReasons: readonly string[];
} {
  if (evalCase.expectedError !== undefined) {
    const explainsRefusal =
      REFUSAL_EXPLANATION_RE.test(finalAnswer) && !AFFIRMATIVE_OPT_OUT_RE.test(finalAnswer);
    return {
      hasExpectedProseAmounts: explainsRefusal,
      missingAmounts: [],
      failureReasons: explainsRefusal
        ? []
        : ["Final answer did not clearly explain the statutory refusal."],
    };
  }

  const missingAmounts = headlineNumbers(evalCase).filter(
    (num) => !containsRmAmount(finalAnswer, num),
  );
  const hasExpectedProseAmounts = missingAmounts.length === 0;
  return {
    hasExpectedProseAmounts,
    missingAmounts,
    failureReasons: hasExpectedProseAmounts
      ? []
      : [
          `Final answer missing expected RM amounts: ${missingAmounts
            .map((n) => n.toFixed(2))
            .join(", ")}.`,
        ],
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
  readonly generatedAt?: string;
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
    generatedAt: params.generatedAt ?? new Date().toISOString(),
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
  return [
    ...(passed < thresholds.minLayer1Passed
      ? [
          `Layer 1 deterministic pass count ${passed}/${total} is below threshold ${thresholds.minLayer1Passed}/${total}.`,
        ]
      : []),
    ...(overallMean < thresholds.minMeanRubricScore
      ? [
          `Layer 2 mean rubric score ${overallMean.toFixed(2)}/${MAX_RUBRIC_SCORE.toFixed(2)} is below threshold ${thresholds.minMeanRubricScore.toFixed(2)}/${MAX_RUBRIC_SCORE.toFixed(2)}.`,
        ]
      : []),
    ...(hallucinatedCitations > thresholds.maxHallucinatedCitations
      ? [
          `Layer 2 detected ${hallucinatedCitations} case(s) with hallucinated citations (max allowed: ${thresholds.maxHallucinatedCitations}).`,
        ]
      : []),
  ];
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
