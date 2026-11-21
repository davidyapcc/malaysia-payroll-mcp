// CLI: runs the eval suite several times per agent model and writes a comparison (`pnpm eval:bench`).
// It reports results and never fails on the gate: use `pnpm eval` for the gate.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentsSdkAgent,
  createAgentsSdkModel,
  parseAgentImplementation,
} from "./agents-sdk.ts";
import {
  type BenchmarkRun,
  buildBenchmarkReport,
  parseBenchModels,
  parseBenchRuns,
  renderBenchmarkMarkdown,
} from "./benchmark.ts";
import { resolveProvider } from "./providers.ts";
import { loadEvalCases, parseConcurrency, runEvalSuite } from "./runner.ts";

const LOCAL_MODEL_CONCURRENCY = 1;

const agentImpl = parseAgentImplementation(process.env.EVAL_AGENT_IMPL);
const models = parseBenchModels(process.env.EVAL_BENCH_MODELS);
const runsPerModel = parseBenchRuns(process.env.EVAL_BENCH_RUNS);
const evalCases = loadEvalCases();
const serverModuleSpecifier = existsSync(new URL("../dist/mcp/server.js", import.meta.url))
  ? "../dist/mcp/server.js"
  : "../src/mcp/server.js";

const runs: BenchmarkRun[] = [];
let agentProvider = "";
let judgeProvider = "";
for (const model of models) {
  const provider = resolveProvider({ ...process.env, EVAL_AGENT_MODEL: model });
  agentProvider = provider.agentProvider;
  judgeProvider = provider.judgeProvider;
  const agent =
    agentImpl === "agents-sdk"
      ? createAgentsSdkAgent(
          createAgentsSdkModel(provider.agentProvider, provider.agentModel, process.env),
        )
      : undefined;
  const isLocal = provider.agentProvider === "ollama" || provider.judgeProvider === "ollama";
  for (let run = 1; run <= runsPerModel; run++) {
    console.log(`Running ${model} (${agentImpl}), run ${run} of ${runsPerModel}...`);
    const startedAt = Date.now();
    const scorecard = await runEvalSuite({
      evalCases,
      llm: provider.client,
      judgeLlm: provider.judgeClient,
      ...(agent !== undefined ? { agent } : {}),
      agentModel: provider.agentModel,
      judgeModel: provider.judgeModel,
      concurrency: parseConcurrency(
        process.env.EVAL_CONCURRENCY,
        isLocal ? LOCAL_MODEL_CONCURRENCY : undefined,
      ),
      serverModuleSpecifier,
    });
    const wallMs = Date.now() - startedAt;
    runs.push({ agentModel: `${model} (${agentImpl})`, scorecard, wallMs });
    console.log(
      `  gate ${scorecard.isGatePassed ? "passed" : "failed"}, Layer 1 ${scorecard.layer1Summary.passRate}%, rubric ${scorecard.layer2Summary.overallMean}, ${Math.round(wallMs / 1000)} s`,
    );
  }
}

const report = buildBenchmarkReport({ runs, agentProvider, judgeProvider });
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });
const stamp = report.generatedAt.replace(/[:.]/g, "-");
const markdown = renderBenchmarkMarkdown(report);
writeFileSync(
  join(outDir, `benchmark-${stamp}.json`),
  `${JSON.stringify({ report, runs }, null, 2)}\n`,
);
writeFileSync(join(outDir, `benchmark-${stamp}.md`), markdown);
console.log(markdown);
