// Aggregates repeated eval runs per model into a comparison table (`pnpm eval:bench`).
import type { Scorecard } from "./scorecard.ts";

const MS_PER_SECOND = 1000;
const DECIMALS_SCALE = 100;
const DEFAULT_BENCH_RUNS = 3;
const PERCENTILE_95 = 0.95;

/** One full eval suite run for one agent model. */
export interface BenchmarkRun {
  readonly agentModel: string;
  readonly scorecard: Scorecard;
  readonly wallMs: number;
}

/** Results for one agent model across all of its runs. */
export interface ModelSummary {
  readonly agentModel: string;
  readonly judgeModel: string;
  readonly runs: number;
  readonly gatePasses: number;
  readonly layer1PassRateMean: number;
  readonly layer1PassRateMin: number;
  readonly layer1PassRateMax: number;
  readonly mustPassFailures: number;
  readonly rubricMean: number;
  readonly hallucinatedCitations: number;
  readonly agentErrors: number;
  readonly judgeErrors: number;
  readonly controlsCaught: number;
  readonly controlsTotal: number;
  readonly caseSecondsMedian: number;
  readonly caseSecondsP95: number;
  readonly runMinutesMean: number;
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly agentProvider: string;
  readonly judgeProvider: string;
  readonly models: readonly ModelSummary[];
}

function round2(value: number): number {
  return Math.round(value * DECIMALS_SCALE) / DECIMALS_SCALE;
}

/** Mean of a non-empty list: every model in a report has at least one run. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty list. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] as number;
}

/** Parses EVAL_BENCH_MODELS: a comma-separated, de-duplicated list of at least one model name. */
export function parseBenchModels(raw: string | undefined): string[] {
  const models = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m !== ""),
    ),
  ];
  if (models.length === 0) {
    throw new Error(
      'Set EVAL_BENCH_MODELS to a comma-separated list, e.g. "qwen3:8b,llama3.1:8b".',
    );
  }
  return models;
}

/** Parses EVAL_BENCH_RUNS: runs per model, default 3, so run-to-run variance shows. */
export function parseBenchRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BENCH_RUNS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid EVAL_BENCH_RUNS "${raw}": expected a positive integer.`);
  }
  return parsed;
}

function summarizeModel(agentModel: string, runs: readonly BenchmarkRun[]): ModelSummary {
  const cards = runs.map((r) => r.scorecard);
  const passRates = cards.map((c) => c.layer1Summary.passRate);
  const caseSeconds = cards.flatMap((c) =>
    c.cases.map((caseResult) => caseResult.durationMs / MS_PER_SECOND),
  );
  const sum = (pick: (c: Scorecard) => number) => cards.reduce((total, c) => total + pick(c), 0);
  return {
    agentModel,
    judgeModel: (cards[0] as Scorecard).judgeModel,
    runs: runs.length,
    gatePasses: cards.filter((c) => c.isGatePassed).length,
    layer1PassRateMean: round2(mean(passRates)),
    layer1PassRateMin: round2(Math.min(...passRates)),
    layer1PassRateMax: round2(Math.max(...passRates)),
    mustPassFailures: sum((c) => c.mustPassSummary.total - c.mustPassSummary.passed),
    rubricMean: round2(mean(cards.map((c) => c.layer2Summary.overallMean))),
    hallucinatedCitations: sum((c) => c.layer2Summary.hallucinatedCitations),
    agentErrors: sum((c) => c.agentErrors),
    judgeErrors: sum((c) => c.judgeErrors),
    controlsCaught: sum((c) => c.controlSummary.caught),
    controlsTotal: sum((c) => c.controlSummary.total),
    caseSecondsMedian: round2(percentile(caseSeconds, 0.5)),
    caseSecondsP95: round2(percentile(caseSeconds, PERCENTILE_95)),
    runMinutesMean: round2(mean(runs.map((r) => r.wallMs)) / MS_PER_SECOND / 60),
  };
}

/** Groups runs by agent model, keeping the order models were first run in. */
export function buildBenchmarkReport(params: {
  readonly runs: readonly BenchmarkRun[];
  readonly agentProvider: string;
  readonly judgeProvider: string;
  readonly generatedAt?: string;
}): BenchmarkReport {
  const byModel = new Map<string, BenchmarkRun[]>();
  for (const run of params.runs) {
    byModel.set(run.agentModel, [...(byModel.get(run.agentModel) ?? []), run]);
  }
  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    agentProvider: params.agentProvider,
    judgeProvider: params.judgeProvider,
    models: [...byModel].map(([model, runs]) => summarizeModel(model, runs)),
  };
}

/** Renders the report as a Markdown table for the README or an ADR. */
export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const header = [
    "| Agent model | Runs | Gate passed | Layer 1 pass rate, mean (min to max) | Must-pass failures | Rubric mean /5 | Hallucinated citations | Agent errors | Judge errors | Controls caught | Case time, median / p95 (s) | Minutes per run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = report.models.map((m) =>
    [
      `\`${m.agentModel}\``,
      m.runs,
      `${m.gatePasses}/${m.runs}`,
      `${m.layer1PassRateMean}% (${m.layer1PassRateMin} to ${m.layer1PassRateMax})`,
      m.mustPassFailures,
      m.rubricMean,
      m.hallucinatedCitations,
      m.agentErrors,
      m.judgeErrors,
      `${m.controlsCaught}/${m.controlsTotal}`,
      `${m.caseSecondsMedian} / ${m.caseSecondsP95}`,
      m.runMinutesMean,
    ].join(" | "),
  );
  const judgeModels = [...new Set(report.models.map((m) => m.judgeModel))].join(", ");
  return [
    "# Agent eval benchmark",
    "",
    `Generated ${report.generatedAt}. Agent provider: ${report.agentProvider}. Judge: ${report.judgeProvider} (${judgeModels}).`,
    "",
    ...header,
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n");
}
