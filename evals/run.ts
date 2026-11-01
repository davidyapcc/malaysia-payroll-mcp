// CLI entry point for running the two-layer agent eval suite (`pnpm eval`).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderScorecardMarkdown } from "./grading.ts";
import { resolveProvider } from "./providers.ts";
import { loadEvalCases, parseConcurrency, runEvalSuite, writeScorecardFiles } from "./runner.ts";

export * from "./grading.ts";
export * from "./providers.ts";
export * from "./runner.ts";

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const provider = resolveProvider();
  const scorecard = await runEvalSuite({
    evalCases: loadEvalCases(),
    llm: provider.client,
    agentModel: provider.agentModel,
    judgeModel: provider.judgeModel,
    concurrency: parseConcurrency(process.env.EVAL_CONCURRENCY),
    serverModuleSpecifier: "../dist/mcp/server.js",
  });
  const { jsonPath, markdownPath } = writeScorecardFiles(
    scorecard,
    undefined,
    process.env.GITHUB_STEP_SUMMARY,
  );

  console.log(renderScorecardMarkdown(scorecard));
  console.log(`Scorecard written to ${jsonPath} and ${markdownPath}`);

  if (!scorecard.isGatePassed) {
    console.error("Eval gate failed:");
    for (const reason of scorecard.gateFailures) {
      console.error(`  - ${reason}`);
    }
    process.exitCode = 1;
  }
}
