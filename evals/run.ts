// CLI entry point for running the two-layer agent eval suite (`pnpm eval`).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeededControl } from "./controls.ts";
import type { EvalCase } from "./grading.ts";
import { resolveProvider } from "./providers.ts";
import {
  concurrencyFor,
  defaultServerModuleSpecifier,
  loadEvalCases,
  runEvalSuite,
  writeScorecardFiles,
} from "./runner.ts";
import { type GateThresholds, renderScorecardMarkdown } from "./scorecard.ts";

export interface RunCliOptions {
  readonly evalCases?: readonly EvalCase[];
  readonly controls?: readonly SeededControl[];
  readonly fetchFn?: typeof fetch;
  readonly serverModuleSpecifier?: string;
  readonly outDir?: string;
  readonly thresholds?: GateThresholds;
}

export async function runCli(
  env: NodeJS.ProcessEnv = process.env,
  options: RunCliOptions = {},
): Promise<number> {
  const provider = resolveProvider(env, options.fetchFn);
  const scorecard = await runEvalSuite({
    evalCases: options.evalCases ?? loadEvalCases(),
    ...(options.controls !== undefined ? { controls: options.controls } : {}),
    llm: provider.client,
    judgeLlm: provider.judgeClient,
    agentModel: provider.agentModel,
    judgeModel: provider.judgeModel,
    concurrency: concurrencyFor(env.EVAL_CONCURRENCY, provider),
    serverModuleSpecifier: options.serverModuleSpecifier ?? defaultServerModuleSpecifier(),
    ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
  });
  const { jsonPath, markdownPath } = writeScorecardFiles(
    scorecard,
    options.outDir,
    env.GITHUB_STEP_SUMMARY,
  );

  console.log(`Agent: ${provider.agentProvider}/${provider.agentModel}`);
  console.log(`Judge: ${provider.judgeProvider}/${provider.judgeModel}`);
  console.log(renderScorecardMarkdown(scorecard));
  console.log(`Scorecard written to ${jsonPath} and ${markdownPath}`);

  if (!scorecard.isGatePassed) {
    console.error("Eval gate failed:");
    for (const reason of scorecard.gateFailures) {
      console.error(`  - ${reason}`);
    }
    return 1;
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const exitCode = await runCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
