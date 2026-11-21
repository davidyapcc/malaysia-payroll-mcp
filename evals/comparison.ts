// Model comparison: repeated eval runs per agent model, summarised side by side (ADR 0005).
// `pnpm eval:compare` reports and never fails on the gate; use `pnpm eval` for the gate.
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentImplementation,
  parseAgentImplementation,
  resolveEvalAgent,
} from "./agents-sdk.ts";
import type { SeededControl } from "./controls.ts";
import type { EvalCase } from "./grading.ts";
import { type ProviderName, resolveProvider } from "./providers.ts";
import {
  concurrencyFor,
  defaultServerModuleSpecifier,
  loadEvalCases,
  parsePositiveInteger,
  runEvalSuite,
} from "./runner.ts";
import type { Scorecard } from "./scorecard.ts";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const BYTES_PER_GIB = 1024 ** 3;
const DECIMALS_SCALE = 100;
const DEFAULT_COMPARE_RUNS = 3;
const MEDIAN = 0.5;
const PERCENTILE_95 = 0.95;
const RUBRIC_DIMENSION_COUNT = 3;

/** One full eval suite run for one agent model. */
export interface ComparisonRun {
  readonly agentModel: string;
  readonly scorecard: Scorecard;
  readonly wallMs: number;
}

/** The machine a comparison ran on: local model results depend on it. */
export interface Hardware {
  readonly platform: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cpuCount: number;
  readonly memoryGib: number;
}

/** Results for one agent model across all of its runs. */
export interface ModelSummary {
  readonly agentModel: string;
  readonly runs: number;
  readonly gatePasses: number;
  readonly layer1PassRateMean: number;
  readonly layer1PassRateMin: number;
  readonly layer1PassRateMax: number;
  /** Must-pass cases that failed Layer 1; agent errors are counted only under `agentErrors`. */
  readonly mustPassFailures: number;
  /** Mean rubric score over every case the judge scored, in every run; null if none was scored. */
  readonly rubricMean: number | null;
  readonly scoredCases: number;
  readonly hallucinatedCitations: number;
  readonly agentErrors: number;
  readonly judgeErrors: number;
  readonly controlsCaught: number;
  readonly controlsTotal: number;
  readonly caseSecondsMedian: number;
  readonly caseSecondsP95: number;
  readonly runMinutesMean: number;
}

export interface Comparison {
  readonly generatedAt: string;
  readonly agentImplementation: AgentImplementation;
  readonly agentProvider: ProviderName;
  readonly judgeProvider: ProviderName;
  readonly judgeModel: string;
  readonly hardware: Hardware;
  readonly models: readonly ModelSummary[];
}

function round2(value: number): number {
  return Math.round(value * DECIMALS_SCALE) / DECIMALS_SCALE;
}

/** Mean of a non-empty list: every model in a comparison has at least one run. */
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

/** Reads the current machine's hardware from `node:os`. */
export function detectHardware(
  os: {
    readonly platform: () => string;
    readonly arch: () => string;
    readonly cpus: () => readonly { readonly model: string }[];
    readonly totalmem: () => number;
  } = { platform, arch, cpus, totalmem },
): Hardware {
  const cores = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpu: cores[0]?.model ?? "unknown",
    cpuCount: cores.length,
    memoryGib: round2(os.totalmem() / BYTES_PER_GIB),
  };
}

/** Parses EVAL_COMPARE_MODELS: a comma-separated, de-duplicated list of at least one model name. */
export function parseCompareModels(raw: string | undefined): string[] {
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
      'Set EVAL_COMPARE_MODELS to a comma-separated list, e.g. "qwen3:8b,llama3.1:8b".',
    );
  }
  return models;
}

/** Parses EVAL_COMPARE_RUNS: runs per model, default 3, so run-to-run variance shows. */
export function parseCompareRuns(raw: string | undefined): number {
  return parsePositiveInteger(raw, "EVAL_COMPARE_RUNS", DEFAULT_COMPARE_RUNS);
}

function summarizeModel(agentModel: string, runs: readonly ComparisonRun[]): ModelSummary {
  const cards = runs.map((r) => r.scorecard);
  const passRates = cards.map((c) => c.layer1Summary.passRate);
  const caseSeconds = cards.flatMap((c) =>
    c.cases.map((caseResult) => caseResult.durationMs / MS_PER_SECOND),
  );
  const caseRubricMeans = cards.flatMap((c) =>
    c.cases.flatMap((caseResult) =>
      caseResult.layer2 === null
        ? []
        : [
            (caseResult.layer2.citationFaithfulness +
              caseResult.layer2.completeness +
              caseResult.layer2.clarity) /
              RUBRIC_DIMENSION_COUNT,
          ],
    ),
  );
  const sum = (pick: (c: Scorecard) => number) => cards.reduce((total, c) => total + pick(c), 0);
  return {
    agentModel,
    runs: runs.length,
    gatePasses: cards.filter((c) => c.isGatePassed).length,
    layer1PassRateMean: round2(mean(passRates)),
    layer1PassRateMin: round2(Math.min(...passRates)),
    layer1PassRateMax: round2(Math.max(...passRates)),
    mustPassFailures: sum((c) => c.mustPassSummary.failedIds.length),
    rubricMean: caseRubricMeans.length === 0 ? null : round2(mean(caseRubricMeans)),
    scoredCases: caseRubricMeans.length,
    hallucinatedCitations: sum((c) => c.layer2Summary.hallucinatedCitations),
    agentErrors: sum((c) => c.agentErrors),
    judgeErrors: sum((c) => c.judgeErrors),
    controlsCaught: sum((c) => c.controlSummary.caught),
    controlsTotal: sum((c) => c.controlSummary.total),
    caseSecondsMedian: round2(percentile(caseSeconds, MEDIAN)),
    caseSecondsP95: round2(percentile(caseSeconds, PERCENTILE_95)),
    runMinutesMean: round2(mean(runs.map((r) => r.wallMs)) / MS_PER_SECOND / SECONDS_PER_MINUTE),
  };
}

/** Groups runs by agent model, keeping the order models were first run in. */
export function buildComparison(params: {
  readonly runs: readonly ComparisonRun[];
  readonly agentImplementation: AgentImplementation;
  readonly agentProvider: ProviderName;
  readonly judgeProvider: ProviderName;
  readonly judgeModel: string;
  readonly hardware: Hardware;
  readonly generatedAt?: string;
}): Comparison {
  const byModel = new Map<string, ComparisonRun[]>();
  for (const run of params.runs) {
    byModel.set(run.agentModel, [...(byModel.get(run.agentModel) ?? []), run]);
  }
  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    agentImplementation: params.agentImplementation,
    agentProvider: params.agentProvider,
    judgeProvider: params.judgeProvider,
    judgeModel: params.judgeModel,
    hardware: params.hardware,
    models: [...byModel].map(([model, runs]) => summarizeModel(model, runs)),
  };
}

/** Renders the comparison as a Markdown table for the README or an ADR. */
export function renderComparisonMarkdown(comparison: Comparison): string {
  const header = [
    "| Agent model | Runs | Gate passed | Layer 1 pass rate, mean (min to max) | Must-pass failures | Rubric mean /5 (cases scored) | Hallucinated citations | Agent errors | Judge errors | Controls caught | Case time, median / p95 (s) | Minutes per run |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = comparison.models.map((m) =>
    [
      `\`${m.agentModel}\``,
      m.runs,
      `${m.gatePasses}/${m.runs}`,
      `${m.layer1PassRateMean}% (${m.layer1PassRateMin} to ${m.layer1PassRateMax})`,
      m.mustPassFailures,
      `${m.rubricMean ?? "n/a"} (${m.scoredCases})`,
      m.hallucinatedCitations,
      m.agentErrors,
      m.judgeErrors,
      `${m.controlsCaught}/${m.controlsTotal}`,
      `${m.caseSecondsMedian} / ${m.caseSecondsP95}`,
      m.runMinutesMean,
    ].join(" | "),
  );
  const hw = comparison.hardware;
  return [
    "# Agent eval model comparison",
    "",
    `Generated ${comparison.generatedAt}. Agent: ${comparison.agentImplementation} on ${comparison.agentProvider}. Judge: ${comparison.judgeProvider}/\`${comparison.judgeModel}\` for every row.`,
    "",
    `Hardware: ${hw.cpu} (${hw.cpuCount} cores), ${hw.memoryGib} GiB RAM, ${hw.platform}/${hw.arch}.`,
    "",
    ...header,
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n");
}

export interface CompareCliOptions {
  readonly evalCases?: readonly EvalCase[];
  readonly controls?: readonly SeededControl[];
  readonly fetchFn?: typeof fetch;
  readonly serverModuleSpecifier?: string;
  readonly outDir?: string;
  readonly hardware?: Hardware;
  readonly log?: (line: string) => void;
}

/**
 * Runs the suite EVAL_COMPARE_RUNS times for each model in EVAL_COMPARE_MODELS, all graded by one
 * fixed judge (EVAL_JUDGE_MODEL, required so rows are comparable), and writes the comparison.
 */
export async function runCompareCli(
  env: NodeJS.ProcessEnv = process.env,
  options: CompareCliOptions = {},
): Promise<{ readonly comparison: Comparison; readonly markdownPath: string }> {
  const judgeModel = env.EVAL_JUDGE_MODEL?.trim();
  if (!judgeModel) {
    throw new Error(
      "Set EVAL_JUDGE_MODEL: a comparison grades every model with one fixed judge, so rows are comparable.",
    );
  }
  const log = options.log ?? console.log;
  const agentImplementation = parseAgentImplementation(env.EVAL_AGENT_IMPL);
  const models = parseCompareModels(env.EVAL_COMPARE_MODELS);
  const runsPerModel = parseCompareRuns(env.EVAL_COMPARE_RUNS);
  const evalCases = options.evalCases ?? loadEvalCases();
  const serverModuleSpecifier = options.serverModuleSpecifier ?? defaultServerModuleSpecifier();

  const runs: ComparisonRun[] = [];
  const providers = models.map((model) =>
    resolveProvider({ ...env, EVAL_AGENT_MODEL: model }, options.fetchFn),
  );
  for (const provider of providers) {
    const agent = resolveEvalAgent(agentImplementation, provider, env, options.fetchFn);
    for (let run = 1; run <= runsPerModel; run++) {
      log(`Running ${provider.agentModel}, run ${run} of ${runsPerModel}...`);
      const startedAt = Date.now();
      const scorecard = await runEvalSuite({
        evalCases,
        ...(options.controls !== undefined ? { controls: options.controls } : {}),
        llm: provider.client,
        judgeLlm: provider.judgeClient,
        ...(agent !== undefined ? { agent } : {}),
        agentModel: provider.agentModel,
        judgeModel: provider.judgeModel,
        concurrency: concurrencyFor(env.EVAL_CONCURRENCY, provider),
        serverModuleSpecifier,
      });
      const wallMs = Date.now() - startedAt;
      runs.push({ agentModel: provider.agentModel, scorecard, wallMs });
      log(
        `  gate ${scorecard.isGatePassed ? "passed" : "failed"}, Layer 1 ${scorecard.layer1Summary.passRate}%, rubric ${scorecard.layer2Summary.overallMean}, ${Math.round(wallMs / MS_PER_SECOND)} s`,
      );
    }
  }

  const [first] = providers as [ReturnType<typeof resolveProvider>];
  const comparison = buildComparison({
    runs,
    agentImplementation,
    agentProvider: first.agentProvider,
    judgeProvider: first.judgeProvider,
    judgeModel,
    hardware: options.hardware ?? detectHardware(),
  });
  const outDir = options.outDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(outDir, { recursive: true });
  const stamp = comparison.generatedAt.replace(/[:.]/g, "-");
  const markdown = renderComparisonMarkdown(comparison);
  const markdownPath = join(outDir, `comparison-${stamp}.md`);
  writeFileSync(
    join(outDir, `comparison-${stamp}.json`),
    `${JSON.stringify({ comparison, runs }, null, 2)}\n`,
  );
  writeFileSync(markdownPath, markdown);
  log(markdown);
  return { comparison, markdownPath };
}
