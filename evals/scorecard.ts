// Scorecard aggregation, the CI gate and the Markdown report for the two-layer agent eval (ADR 0004).
import { type ControlEvaluation, describeExpectation } from "./controls.ts";
import {
  type CaseEvaluation,
  MAX_RUBRIC_SCORE,
  MIN_RUBRIC_SCORE,
  type RubricScore,
} from "./grading.ts";

const PERCENT_SCALE = 100;
const RUBRIC_DIMENSION_COUNT = 3;
const GATE_MEAN_DECIMALS = 2;

/** Layer 1 misses allowed among standard (non-refusal) cases. Refusal cases never get a miss. */
export const LAYER1_ALLOWED_MISSES = 2;
/** Judge errors that fail the gate. Any error is a failure, so this stays at zero. */
export const MAX_JUDGE_ERRORS = 0;
/** Agent errors that fail the gate. Any error is a failure, so this stays at zero. */
export const MAX_AGENT_ERRORS = 0;

export interface GateThresholds {
  readonly maxLayer1Misses: number;
  readonly minMeanRubricScore: number;
  readonly maxHallucinatedCitations: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  maxLayer1Misses: LAYER1_ALLOWED_MISSES,
  minMeanRubricScore: 4.0,
  maxHallucinatedCitations: 0,
};

export interface Layer1Summary {
  readonly passed: number;
  readonly total: number;
  readonly minPassed: number;
  readonly passRate: number;
  readonly toolSelectionPassed: number;
  readonly argsMatchedPassed: number;
  readonly toolOutputMatchedPassed: number;
  readonly proseCheckPassed: number;
}

export interface MustPassSummary {
  readonly passed: number;
  readonly total: number;
  readonly failedIds: readonly string[];
  readonly isCausingFailure: boolean;
}

export interface Layer2Summary {
  readonly scoredCases: number;
  readonly meanCitationFaithfulness: number;
  readonly meanCompleteness: number;
  readonly meanClarity: number;
  readonly overallMean: number;
  readonly hallucinatedCitations: number;
}

export interface ControlSummary {
  readonly caught: number;
  readonly total: number;
  readonly missedIds: readonly string[];
}

export interface Scorecard {
  readonly generatedAt: string;
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly totalCases: number;
  readonly isGatePassed: boolean;
  readonly gateFailures: readonly string[];
  readonly thresholds: GateThresholds;
  readonly layer1Summary: Layer1Summary;
  readonly mustPassSummary: MustPassSummary;
  readonly layer2Summary: Layer2Summary;
  readonly judgeErrors: number;
  readonly agentErrors: number;
  readonly controlSummary: ControlSummary;
  readonly cases: readonly CaseEvaluation[];
  readonly controls: readonly ControlEvaluation[];
}

interface ScorecardInput {
  readonly cases: readonly CaseEvaluation[];
  readonly controls: readonly ControlEvaluation[];
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly thresholds?: GateThresholds;
  readonly generatedAt?: string;
}

function round2(value: number): number {
  return Math.round(value * PERCENT_SCALE) / PERCENT_SCALE;
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function countWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

function summarizeLayer1(
  cases: readonly CaseEvaluation[],
  thresholds: GateThresholds,
): Layer1Summary {
  const total = cases.length;
  const passed = countWhere(cases, (c) => c.layer1.isPassed);
  return {
    passed,
    total,
    minPassed: Math.max(0, total - thresholds.maxLayer1Misses),
    passRate: total === 0 ? 0 : round2((passed / total) * PERCENT_SCALE),
    toolSelectionPassed: countWhere(cases, (c) => c.layer1.hasExpectedTool),
    argsMatchedPassed: countWhere(cases, (c) => c.layer1.hasMatchingArgs),
    toolOutputMatchedPassed: countWhere(cases, (c) => c.layer1.hasMatchingToolOutput),
    proseCheckPassed: countWhere(cases, (c) => c.layer1.hasValidProse),
  };
}

/** Agent errors are counted only under agentErrors, so a must-pass case is never reported twice. */
function summarizeMustPass(cases: readonly CaseEvaluation[]): MustPassSummary {
  const failedIds = cases
    .filter((c) => !c.layer1.isPassed && c.agentError === null)
    .map((c) => c.id);
  return {
    passed: countWhere(cases, (c) => c.layer1.isPassed),
    total: cases.length,
    failedIds,
    isCausingFailure: failedIds.length > 0,
  };
}

function summarizeLayer2(cases: readonly CaseEvaluation[]): Layer2Summary {
  const scores: RubricScore[] = cases.flatMap((c) => (c.layer2 === null ? [] : [c.layer2]));
  const meanCitationFaithfulness = meanOf(scores.map((s) => s.citationFaithfulness));
  const meanCompleteness = meanOf(scores.map((s) => s.completeness));
  const meanClarity = meanOf(scores.map((s) => s.clarity));
  return {
    scoredCases: scores.length,
    meanCitationFaithfulness,
    meanCompleteness,
    meanClarity,
    overallMean: round2(
      (meanCitationFaithfulness + meanCompleteness + meanClarity) / RUBRIC_DIMENSION_COUNT,
    ),
    hallucinatedCitations: countWhere(scores, (s) => s.hasHallucinatedCitation),
  };
}

function summarizeControls(controls: readonly ControlEvaluation[]): ControlSummary {
  return {
    caught: countWhere(controls, (c) => c.isCaught),
    total: controls.length,
    missedIds: controls.filter((c) => c.judgeError === null && !c.isCaught).map((c) => c.id),
  };
}

function countJudgeErrors(
  cases: readonly CaseEvaluation[],
  controls: readonly ControlEvaluation[],
): number {
  return (
    countWhere(cases, (c) => c.judgeError !== null) +
    countWhere(controls, (c) => c.judgeError !== null)
  );
}

function mustPassFailures(summary: MustPassSummary): string[] {
  if (!summary.isCausingFailure) return [];
  return [
    `Must-pass refusal case(s) failed Layer 1: ${summary.failedIds.join(", ")}. Refusal cases must pass regardless of the suite count.`,
  ];
}

function layer1Failures(summary: Layer1Summary, thresholds: GateThresholds): string[] {
  if (summary.passed >= summary.minPassed) return [];
  return [
    `Layer 1 deterministic pass count ${summary.passed}/${summary.total} is below threshold ${summary.minPassed}/${summary.total} (${thresholds.maxLayer1Misses} misses allowed; refusal cases excluded).`,
  ];
}

function layer2Failures(summary: Layer2Summary, thresholds: GateThresholds): string[] {
  const failures: string[] = [];
  if (summary.overallMean < thresholds.minMeanRubricScore) {
    failures.push(
      `Layer 2 mean rubric score ${summary.overallMean.toFixed(GATE_MEAN_DECIMALS)}/${MAX_RUBRIC_SCORE.toFixed(GATE_MEAN_DECIMALS)} is below threshold ${thresholds.minMeanRubricScore.toFixed(GATE_MEAN_DECIMALS)}/${MAX_RUBRIC_SCORE.toFixed(GATE_MEAN_DECIMALS)}.`,
    );
  }
  if (summary.hallucinatedCitations > thresholds.maxHallucinatedCitations) {
    failures.push(
      `Layer 2 detected ${summary.hallucinatedCitations} case(s) with hallucinated citations (max allowed: ${thresholds.maxHallucinatedCitations}).`,
    );
  }
  return failures;
}

function controlFailures(summary: ControlSummary): string[] {
  if (summary.missedIds.length === 0) return [];
  return [
    `Judge passed ${summary.missedIds.length} seeded control(s) it must catch: ${summary.missedIds.join(", ")}.`,
  ];
}

function agentErrorFailures(agentErrors: number): string[] {
  if (agentErrors <= MAX_AGENT_ERRORS) return [];
  return [
    `Agent errors: ${agentErrors} case(s) failed after one retry, so they were not graded. Any agent error fails the gate.`,
  ];
}

function judgeErrorFailures(judgeErrors: number): string[] {
  if (judgeErrors <= MAX_JUDGE_ERRORS) return [];
  return [
    `Judge errors: ${judgeErrors} case(s) or control(s) could not be scored after one retry. Any judge error fails the gate.`,
  ];
}

/** Aggregates per-case results and seeded controls into a scorecard and evaluates the CI gate. */
export function buildScorecard(params: ScorecardInput): Scorecard {
  const thresholds = params.thresholds ?? DEFAULT_THRESHOLDS;
  const standardCases = params.cases.filter((c) => !c.isMustPass);
  const mustPassCases = params.cases.filter((c) => c.isMustPass);
  const layer1Summary = summarizeLayer1(standardCases, thresholds);
  const mustPassSummary = summarizeMustPass(mustPassCases);
  const layer2Summary = summarizeLayer2(params.cases);
  const controlSummary = summarizeControls(params.controls);
  const judgeErrors = countJudgeErrors(params.cases, params.controls);
  const agentErrors = countWhere(params.cases, (c) => c.agentError !== null);
  const gateFailures = [
    ...mustPassFailures(mustPassSummary),
    ...layer1Failures(layer1Summary, thresholds),
    ...layer2Failures(layer2Summary, thresholds),
    ...controlFailures(controlSummary),
    ...judgeErrorFailures(judgeErrors),
    ...agentErrorFailures(agentErrors),
  ];

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    agentModel: params.agentModel,
    judgeModel: params.judgeModel,
    totalCases: params.cases.length,
    isGatePassed: gateFailures.length === 0,
    gateFailures,
    thresholds,
    layer1Summary,
    mustPassSummary,
    layer2Summary,
    judgeErrors,
    agentErrors,
    controlSummary,
    cases: params.cases,
    controls: params.controls,
  };
}

function rateStr(passed: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((passed / total) * PERCENT_SCALE).toFixed(1)}%`;
}

function renderGateFailures(scorecard: Scorecard): string[] {
  if (scorecard.gateFailures.length === 0) return [];
  return ["## Gate Failures", "", ...scorecard.gateFailures.map((f) => `- ${f}`), ""];
}

function renderMustPass(summary: MustPassSummary): string[] {
  const failedIds = summary.failedIds.length > 0 ? summary.failedIds.join(", ") : "none";
  const causeLine = summary.isCausingFailure
    ? `- **Caused gate failure**: yes. ${failedIds} failed Layer 1, and refusal cases must pass.`
    : "- **Caused gate failure**: no.";
  return [
    "## Must-Pass Refusal Cases",
    "",
    "| Passed | Total | Failed IDs |",
    "| --- | --- | --- |",
    `| ${summary.passed} | ${summary.total} | ${failedIds} |`,
    "",
    causeLine,
    "",
  ];
}

function renderLayer1(summary: Layer1Summary): string[] {
  return [
    "## Layer 1: Deterministic Tool-Use Summary (standard cases)",
    "",
    "| Check | Passed | Total | Rate |",
    "| --- | --- | --- | --- |",
    `| Tool selection | ${summary.toolSelectionPassed} | ${summary.total} | ${rateStr(summary.toolSelectionPassed, summary.total)} |`,
    `| Schema arguments | ${summary.argsMatchedPassed} | ${summary.total} | ${rateStr(summary.argsMatchedPassed, summary.total)} |`,
    `| Tool structured output | ${summary.toolOutputMatchedPassed} | ${summary.total} | ${rateStr(summary.toolOutputMatchedPassed, summary.total)} |`,
    `| Exact statutory numbers in prose | ${summary.proseCheckPassed} | ${summary.total} | ${rateStr(summary.proseCheckPassed, summary.total)} |`,
    `| **Overall Layer 1** | **${summary.passed}** | **${summary.total}** | **${summary.passRate.toFixed(1)}%** |`,
    "",
  ];
}

function renderLayer2(scorecard: Scorecard): string[] {
  const l2 = scorecard.layer2Summary;
  const maxScore = MAX_RUBRIC_SCORE.toFixed(GATE_MEAN_DECIMALS);
  return [
    `## Layer 2: Model-Based Rubric Summary (${MIN_RUBRIC_SCORE}–${MAX_RUBRIC_SCORE})`,
    "",
    "| Dimension | Mean Score |",
    "| --- | --- |",
    `| Citation faithfulness | ${l2.meanCitationFaithfulness.toFixed(GATE_MEAN_DECIMALS)} / ${maxScore} |`,
    `| Completeness | ${l2.meanCompleteness.toFixed(GATE_MEAN_DECIMALS)} / ${maxScore} |`,
    `| Clarity | ${l2.meanClarity.toFixed(GATE_MEAN_DECIMALS)} / ${maxScore} |`,
    `| **Overall Mean** | **${l2.overallMean.toFixed(GATE_MEAN_DECIMALS)} / ${maxScore}** |`,
    `| Hallucinated citations | ${l2.hallucinatedCitations} |`,
    `| Cases scored by the judge | ${l2.scoredCases} of ${scorecard.totalCases} |`,
    `| Judge errors (after one retry) | ${scorecard.judgeErrors} |`,
    `| Agent errors (after one retry) | ${scorecard.agentErrors} |`,
    "",
  ];
}

function renderControls(summary: ControlSummary, controls: readonly ControlEvaluation[]): string[] {
  const missed = summary.missedIds.length > 0 ? summary.missedIds.join(", ") : "none";
  return [
    "## Seeded Controls (judge must catch each)",
    "",
    "| ID | Must do | Caught |",
    "| --- | --- | --- |",
    ...controls.map(renderControlRow),
    "",
    `- **Caught**: ${summary.caught} of ${summary.total}. **Missed**: ${missed}.`,
    "",
  ];
}

function renderControlRow(control: ControlEvaluation): string {
  const caught = control.judgeError !== null ? "JUDGE ERROR" : control.isCaught ? "YES" : "NO";
  return `| ${control.id} | ${describeExpectation(control.expectation)} | ${caught} |`;
}

function renderScoreCells(scores: RubricScore | null): string {
  if (scores === null) return "n/a | n/a | n/a | n/a";
  const hallucinated = scores.hasHallucinatedCitation ? "YES" : "no";
  return `${scores.citationFaithfulness} | ${scores.completeness} | ${scores.clarity} | ${hallucinated}`;
}

/** The judge note, or nothing for an agent error, whose reason is already in the Layer 1 reasons. */
function caseDetail(c: CaseEvaluation): string[] {
  if (c.agentError !== null) return [];
  return [c.layer2 === null ? `Judge error: ${String(c.judgeError)}` : c.layer2.rationale];
}

function renderCaseRow(c: CaseEvaluation): string {
  const mustPassMark = c.isMustPass ? " (must-pass)" : "";
  const l1Badge = `${c.layer1.isPassed ? "PASS" : "FAIL"}${mustPassMark}`;
  const note = [...c.layer1.failureReasons, ...caseDetail(c)].join(" | ");
  const escapedNote = note.replaceAll("|", "\\|").replaceAll("\n", " ");
  return `| ${c.id} | \`${c.expectedTool}\` | ${l1Badge} | ${renderScoreCells(c.layer2)} | ${escapedNote} |`;
}

/** Renders the scorecard as a Markdown report for CI job summaries and artifacts. */
export function renderScorecardMarkdown(scorecard: Scorecard): string {
  const status = scorecard.isGatePassed ? "PASS" : "FAIL";
  const l1 = scorecard.layer1Summary;
  const maxScore = MAX_RUBRIC_SCORE.toFixed(GATE_MEAN_DECIMALS);
  const lines: string[] = [
    `# Malaysia Payroll MCP — Agent Eval Scorecard (${status})`,
    "",
    `- **Generated at**: \`${scorecard.generatedAt}\``,
    `- **Agent model**: \`${scorecard.agentModel}\``,
    `- **Judge model**: \`${scorecard.judgeModel}\``,
    `- **Total cases**: ${scorecard.totalCases} (${l1.total} standard, ${scorecard.mustPassSummary.total} must-pass refusal)`,
    `- **CI Gate**: **${status}** (thresholds: Layer 1 >= ${l1.minPassed}/${l1.total} standard cases, every must-pass refusal case passes, Layer 2 mean >= ${scorecard.thresholds.minMeanRubricScore.toFixed(GATE_MEAN_DECIMALS)}/${maxScore}, hallucinated citations <= ${scorecard.thresholds.maxHallucinatedCitations}, judge errors = ${MAX_JUDGE_ERRORS}, agent errors = ${MAX_AGENT_ERRORS}, every seeded control caught)`,
    "",
    ...renderGateFailures(scorecard),
    ...renderMustPass(scorecard.mustPassSummary),
    ...renderLayer1(l1),
    ...renderLayer2(scorecard),
    ...renderControls(scorecard.controlSummary, scorecard.controls),
    "## Per-Case Breakdown",
    "",
    "| ID | Tool | Layer 1 | Cite | Comp | Clar | Hallucinated | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scorecard.cases.map(renderCaseRow),
    "",
  ];
  return lines.join("\n");
}
