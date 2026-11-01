// CLI entry point for running the two-layer agent eval suite (`pnpm eval`).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvalCase, type GateThresholds, renderScorecardMarkdown } from "./grading.ts";
import { resolveProvider } from "./providers.ts";
import { loadEvalCases, parseConcurrency, runEvalSuite, writeScorecardFiles } from "./runner.ts";

export interface RunCliOptions {
  readonly evalCases?: readonly EvalCase[];
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
    llm: provider.client,
    agentModel: provider.agentModel,
    judgeModel: provider.judgeModel,
    concurrency: parseConcurrency(env.EVAL_CONCURRENCY),
    serverModuleSpecifier: options.serverModuleSpecifier ?? "../dist/mcp/server.js",
    ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
  });
  const { jsonPath, markdownPath } = writeScorecardFiles(
    scorecard,
    options.outDir,
    env.GITHUB_STEP_SUMMARY,
  );

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
