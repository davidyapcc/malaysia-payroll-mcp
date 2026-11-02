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
  readonly hasValidProse: boolean;
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
  readonly isMustPass: boolean;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalAnswer: string;
  readonly layer1: Layer1Result;
  /** Null when the judge could not score the answer after its retry (see `judgeError`). */
  readonly layer2: RubricScore | null;
  readonly judgeError: string | null;
  /** Set when the agent failed twice in a round. Such a case is not graded or judged. */
  readonly agentError: string | null;
  readonly durationMs: number;
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

export type AmountParty = "employee" | "employer";

export interface HeadlineAmount {
  readonly amount: number;
  /** Party the answer must name next to this amount, or null when the amount needs no party. */
  readonly party: AmountParty | null;
}

function amountOf(value: unknown, party: AmountParty | null): HeadlineAmount[] {
  return typeof value === "number" ? [{ amount: value, party }] : [];
}

const NET_PAY_EMPLOYEE_KEYS = ["epf", "socso", "skbbk", "eis", "mtd"] as const;
const NET_PAY_EMPLOYER_KEYS = ["epf", "socso", "eis"] as const;

/** Employee deductions and employer contributions name their party; totals and cost do not. */
function netPayAmounts(expected: Record<string, unknown>): HeadlineAmount[] {
  const ded = expected.deductions;
  const er = expected.employerContributions;
  const employee = NET_PAY_EMPLOYEE_KEYS.flatMap((key) =>
    amountOf(pickField(ded, key), "employee"),
  );
  const employer = NET_PAY_EMPLOYER_KEYS.flatMap((key) => amountOf(pickField(er, key), "employer"));
  const unlabelled: unknown[] = [
    expected.netPay,
    pickField(ded, "total"),
    pickField(er, "total"),
    expected.employerCost,
  ];
  return [...employee, ...employer, ...unlabelled.flatMap((value) => amountOf(value, null))];
}

/**
 * Extracts every headline statutory RM figure from a golden case's `expected` object that must
 * appear in the agent's final answer. The EPF and SOCSO/EIS shares must name their paying party,
 * because swapping employer and employee shares is a wrong answer.
 */
export function headlineAmounts(evalCase: EvalCase): HeadlineAmount[] {
  const expected = evalCase.expectedOutput;
  if (expected === undefined) return [];

  if (evalCase.expectedTool === "calculate_epf") {
    return [
      ...amountOf(expected.employer, "employer"),
      ...amountOf(expected.employee, "employee"),
      ...amountOf(expected.total, null),
    ];
  }
  if (evalCase.expectedTool === "calculate_socso_eis") {
    return [
      ...amountOf(pickField(expected.socso, "employer"), "employer"),
      ...amountOf(pickField(expected.socso, "employee"), "employee"),
      ...amountOf(pickField(expected.skbbk, "employee"), null),
      ...amountOf(pickField(expected.eis, "employer"), "employer"),
      ...amountOf(pickField(expected.eis, "employee"), "employee"),
    ];
  }
  if (evalCase.expectedTool === "calculate_mtd") return amountOf(expected.mtd, null);
  return netPayAmounts(expected);
}

const RM_PREFIXED_RE = /(?:RM|MYR)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d%]|\.\d)/gi;
const DECIMAL_MONEY_RE = /(?<![.\d-])(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d%]|\.\d)/g;
const ZERO_WORD_RE = /(?<!\bnot\s+)\b(?:nil|exempt(?:ed)?|zero|pays?\s+nothing)\b/i;

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

const PARTY_WORD_RE = /\b(employee|employer)s?\b/gi;
const ZERO_WORD_GLOBAL_RE = /(?<!\bnot\s+)\b(?:nil|exempt(?:ed)?|zero|pays?\s+nothing)\b/gi;
/**
 * Semicolons, clause commas and sentence ends split a line into attribution scopes. A comma inside
 * a number (`RM 3,000`) is followed by a digit, so it does not split. Nor does a comma before an
 * "each" clause, which refers back to the parties just named.
 */
const SENTENCE_BREAK_RE = /;|,\s+(?!(?:with\s+)?each\b)(?=\D)|\.\s+(?=[A-Z])/;
/** A line that introduces what follows: a Markdown heading, a line ending in a colon, or all bold. */
const LABEL_LINE_RE = /^\s*#|:[\s*_]*$|^[\s\d.*_-]*\*\*[^*]+\*\*[\s*_]*$/;
/** A line that is only a "Deductions" heading: deductions come off the employee's pay. */
const DEDUCTIONS_HEADING_RE = /^[\s#*_-]*(?:\w+\s+)?deductions?[\s:*_#-]*$/i;

interface Span {
  readonly index: number;
  readonly end: number;
}

interface AmountMention extends Span {
  readonly kind: "amount";
  readonly value: number;
}

interface PartyMention extends Span {
  readonly kind: "party";
  readonly party: AmountParty;
}

interface ScopeMentions {
  readonly amounts: readonly AmountMention[];
  readonly parties: readonly PartyMention[];
}

interface AttributedAmount {
  readonly value: number;
  /** Parties the amount is attributed to. Empty when the prose names no party for it. */
  readonly parties: readonly AmountParty[];
}

function amountValueOf(token: string): number {
  return Number(token.replace(/^(?:RM|MYR)\s*/i, "").replaceAll(",", ""));
}

function spanOf(match: RegExpExecArray): Span {
  return { index: match.index, end: match.index + match[0].length };
}

function amountMentionsOf(scope: string): AmountMention[] {
  const prefixed = [...scope.matchAll(RM_PREFIXED_RE)];
  // A bare 2-decimal amount inside an RM-prefixed match is the same figure, so it is not counted twice.
  const bare = [...scope.matchAll(DECIMAL_MONEY_RE)].filter((match) => {
    const { index } = spanOf(match);
    return !prefixed.some((p) => index >= spanOf(p).index && index < spanOf(p).end);
  });
  const numeric = [...prefixed, ...bare].map(
    (match): AmountMention => ({
      kind: "amount",
      value: amountValueOf(match[0]),
      ...spanOf(match),
    }),
  );
  const zeros = [...scope.matchAll(ZERO_WORD_GLOBAL_RE)].map(
    (match): AmountMention => ({ kind: "amount", value: 0, ...spanOf(match) }),
  );
  return [...numeric, ...zeros];
}

function partyMentionsOf(scope: string): PartyMention[] {
  return [...scope.matchAll(PARTY_WORD_RE)].map(
    (match): PartyMention => ({
      kind: "party",
      party: match[1]?.toLowerCase() === "employer" ? "employer" : "employee",
      ...spanOf(match),
    }),
  );
}

/** Characters between two spans, or 0 when they touch. */
function gapBetween(a: Span, b: Span): number {
  return a.index >= b.end ? a.index - b.end : Math.max(0, b.index - a.end);
}

/** The party of the party word nearest this amount in its scope; the earlier word wins a tie. */
function nearestParty(amount: AmountMention, parties: readonly PartyMention[]): AmountParty {
  return parties.reduce((best, party) =>
    gapBetween(amount, party) < gapBetween(amount, best) ? party : best,
  ).party;
}

/**
 * Parties for one amount. A scope that names no party inherits the last party named before it,
 * which covers an answer that lists figures under an "Employee Deductions" heading. A scope with
 * one amount that names both parties means both pay it. Otherwise the nearest party word wins, so
 * "employer RM330 and employee RM390" attributes RM330 to the employer.
 */
function partiesFor(
  scope: ScopeMentions,
  amount: AmountMention,
  lastParty: AmountParty | null,
): readonly AmountParty[] {
  if (scope.parties.length === 0) return lastParty === null ? [] : [lastParty];
  const namedParties = new Set(scope.parties.map((party) => party.party));
  if (scope.amounts.length === 1 && namedParties.size === 2) return ["employee", "employer"];
  return [nearestParty(amount, scope.parties)];
}

interface AttributionState {
  readonly lastParty: AmountParty | null;
  readonly attributed: readonly AttributedAmount[];
}

/**
 * Attributes one line's amounts. The party carries between scopes within the line. It carries to
 * later lines only from a label with no amount, so a note on one figure ("employer pays") or a
 * rule quoted under it does not relabel the figures listed after it.
 */
function attributeLine(state: AttributionState, line: string): AttributionState {
  const scopes: ScopeMentions[] = line.split(SENTENCE_BREAK_RE).map((scope) => ({
    amounts: amountMentionsOf(scope),
    parties: partyMentionsOf(scope),
  }));
  const withinLine = scopes.reduce<AttributionState>(
    (current, scope) => ({
      lastParty: scope.parties.at(-1)?.party ?? current.lastParty,
      attributed: [
        ...current.attributed,
        ...scope.amounts.map((amount) => ({
          value: amount.value,
          parties: partiesFor(scope, amount, current.lastParty),
        })),
      ],
    }),
    { lastParty: state.lastParty, attributed: [] },
  );
  return {
    lastParty: carriedParty(state.lastParty, line, scopes, withinLine),
    attributed: [...state.attributed, ...withinLine.attributed],
  };
}

function carriedParty(
  previous: AmountParty | null,
  line: string,
  scopes: readonly ScopeMentions[],
  withinLine: AttributionState,
): AmountParty | null {
  if (withinLine.attributed.length > 0 || !LABEL_LINE_RE.test(line)) return previous;
  if (scopes.some((scope) => scope.parties.length > 0)) return withinLine.lastParty;
  return DEDUCTIONS_HEADING_RE.test(line) ? "employee" : previous;
}

/** Attributes each RM amount in the prose to one or more parties, line by line. */
function attributeAmounts(prose: string): readonly AttributedAmount[] {
  return prose.split("\n").reduce(attributeLine, { lastParty: null, attributed: [] }).attributed;
}

function isHeadlineAmountFound(
  headline: HeadlineAmount,
  finalAnswer: string,
  attributed: readonly AttributedAmount[],
): boolean {
  const party = headline.party;
  if (party === null) return containsRmAmount(finalAnswer, headline.amount);
  return attributed.some(
    (entry) =>
      entry.parties.includes(party) && Math.abs(entry.value - headline.amount) < AMOUNT_TOLERANCE,
  );
}

const REFUSAL_EXPLANATION_RE =
  /(?:cannot|can't|(?:not|isn't)\s+(?:allowed|permitted|eligible|possible|available)|unable|prohibited)\b[^.\n]*\bopt(?:ing)?[\s-]*out|opt(?:ing)?[\s-]*out\b[^.\n]*\b(?:(?:not|isn't)\s+(?:allowed|permitted|eligible|possible|available)|prohibited)|\bmandatory\b/i;
const AFFIRMATIVE_OPT_OUT_RE =
  /(?<!\bnot\s+)\b(?:can|may|allowed\s+to|permitted\s+to|eligible\s+to)\s+opt[\s-]*out\b/i;

/** Layer 1 result for a case whose agent failed: not passed, with the agent error as the only reason. */
export function agentErrorLayer1(message: string): Layer1Result {
  return {
    isPassed: false,
    hasExpectedTool: false,
    hasMatchingArgs: false,
    hasMatchingToolOutput: false,
    hasValidProse: false,
    missingAmounts: [],
    failureReasons: [`Agent error: ${message}`],
  };
}

/** Refusal cases (`expectedError` set) are must-pass: they fail the gate on their own if Layer 1 fails. */
export function isMustPassCase(evalCase: EvalCase): boolean {
  return evalCase.expectedError !== undefined;
}

/**
 * Finds the call Layer 1 inspects. Refusal cases inspect the first call, so retries after the
 * expected refusal are allowed. Other cases inspect the call to the expected tool.
 */
function findInspectedCall(
  evalCase: EvalCase,
  toolCalls: readonly RecordedToolCall[],
): RecordedToolCall | undefined {
  const candidate = isMustPassCase(evalCase)
    ? toolCalls[0]
    : toolCalls.find((call) => call.name === evalCase.expectedTool);
  return candidate?.name === evalCase.expectedTool ? candidate : undefined;
}

/** Evaluates Layer 1 (deterministic tool selection, argument extraction and statutory numbers). */
export function evaluateLayer1(
  evalCase: EvalCase,
  toolCalls: readonly RecordedToolCall[],
  finalAnswer: string,
): Layer1Result {
  const matchingCall = findInspectedCall(evalCase, toolCalls);
  const allowsRetries = isMustPassCase(evalCase);
  const hasExpectedTool = matchingCall !== undefined && (allowsRetries || toolCalls.length === 1);
  const toolErrors = hasExpectedTool
    ? []
    : [
        `Expected ${allowsRetries ? "first" : "single"} tool call to "${evalCase.expectedTool}", got: ${
          toolCalls.length === 0 ? "none" : toolCalls.map((c) => c.name).join(", ")
        }.`,
      ];

  const argsCheck = checkArgsMatch(evalCase, matchingCall);
  const toolOutputCheck = checkToolOutputMatch(evalCase, matchingCall);
  const proseCheck = checkProseMatch(evalCase, finalAnswer, toolCalls);

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
      proseCheck.hasValidProse,
    hasExpectedTool,
    hasMatchingArgs: argsCheck.hasMatchingArgs,
    hasMatchingToolOutput: toolOutputCheck.hasMatchingToolOutput,
    hasValidProse: proseCheck.hasValidProse,
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

interface ProseCheck {
  readonly hasValidProse: boolean;
  readonly missingAmounts: readonly number[];
  readonly failureReasons: readonly string[];
}

function containsAnyRmAmount(prose: string): boolean {
  return [RM_PREFIXED_RE, DECIMAL_MONEY_RE].some((regex) => prose.match(regex) !== null);
}

function checkRefusalProse(
  finalAnswer: string,
  toolCalls: readonly RecordedToolCall[],
): ProseCheck {
  const hasSucceededCall = toolCalls.some((call) => !call.isError);
  const failureReasons = [
    ...(AFFIRMATIVE_OPT_OUT_RE.test(finalAnswer)
      ? ["Final answer affirms the opt-out, which the statute does not allow."]
      : []),
    ...(REFUSAL_EXPLANATION_RE.test(finalAnswer)
      ? []
      : ["Final answer did not clearly explain the statutory refusal."]),
    ...(hasSucceededCall || !containsAnyRmAmount(finalAnswer)
      ? []
      : ["Final answer presents RM amounts although no tool call succeeded."]),
  ];
  return { hasValidProse: failureReasons.length === 0, missingAmounts: [], failureReasons };
}

function describeHeadline(headline: HeadlineAmount): string {
  const amount = headline.amount.toFixed(2);
  return headline.party === null ? amount : `${amount} (${headline.party})`;
}

function checkAmountProse(evalCase: EvalCase, finalAnswer: string): ProseCheck {
  const attributed = attributeAmounts(finalAnswer);
  const missing = headlineAmounts(evalCase).filter(
    (headline) => !isHeadlineAmountFound(headline, finalAnswer, attributed),
  );
  const hasValidProse = missing.length === 0;
  return {
    hasValidProse,
    missingAmounts: missing.map((headline) => headline.amount),
    failureReasons: hasValidProse
      ? []
      : [`Final answer missing expected RM amounts: ${missing.map(describeHeadline).join(", ")}.`],
  };
}

function checkProseMatch(
  evalCase: EvalCase,
  finalAnswer: string,
  toolCalls: readonly RecordedToolCall[],
): ProseCheck {
  return isMustPassCase(evalCase)
    ? checkRefusalProse(finalAnswer, toolCalls)
    : checkAmountProse(evalCase, finalAnswer);
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
