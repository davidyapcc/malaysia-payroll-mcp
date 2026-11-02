// Agent tool-use loop, judge orchestration and scorecard writer for the eval harness.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { VERSION } from "../src/version.ts";
import {
  type ControlEvaluation,
  isControlCaught,
  loadSeededControls,
  type SeededControl,
} from "./controls.ts";
import {
  buildEvalCases,
  type CaseEvaluation,
  type EvalCase,
  evaluateLayer1,
  goldenFileSchema,
  isMustPassCase,
  isPlainObject,
  parseCasesJsonl,
  parseJudgeResponse,
  type RecordedToolCall,
  type RubricScore,
} from "./grading.ts";
import { DEFAULT_ANTHROPIC_MODEL, type LlmClient } from "./providers.ts";
import {
  buildScorecard,
  type GateThresholds,
  renderScorecardMarkdown,
  type Scorecard,
} from "./scorecard.ts";

const DEFAULT_CONCURRENCY = 5;
const MAX_AGENT_TOKENS = 1024;
const MAX_JUDGE_TOKENS = 512;
const MAX_TOOL_ROUNDS = 3;
/** The judge gets one retry after a network, HTTP or parse failure. */
const JUDGE_MAX_ATTEMPTS = 2;

export interface JudgeOutcome {
  readonly score: RubricScore | null;
  readonly error: string | null;
}

interface JudgeInput {
  readonly caseId: string;
  readonly prompt: string;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalAnswer: string;
}

export const AGENT_SYSTEM_PROMPT = [
  "You are a Malaysian statutory payroll assistant connected to the malaysia-payroll-mcp server.",
  "Use the MCP tools to compute statutory contributions, deductions, and net pay rather than calculating manually.",
  "In your response:",
  "1. Present the computed RM figures clearly with two decimal places, detailing employee, employer, and total amounts where relevant.",
  "2. Cite the relevant statutory rules, rate tables, official sources, and effective dates provided by the tools.",
  "3. Note that calculations apply to fixed monthly salaries only and do not constitute tax or legal advice.",
].join("\n");

export const JUDGE_SYSTEM_PROMPT = [
  "You are an impartial, rigorous payroll evaluation judge grading an AI agent's answer to a Malaysian statutory payroll query.",
  "You are provided: the user prompt, the recorded tool calls and structured outputs (or error messages), and the agent's final answer.",
  "Evaluate and score the agent's answer on three distinct integer dimensions from 1 (unacceptable) to 5 (flawless):",
  "",
  "1. `citationFaithfulness` (1-5):",
  "- Score 5: Every citation (rule, rate-table row/band, source title, effective date) strictly matches the tool output with no invented facts.",
  "- Score 3-4: Mostly faithful, minor omission or minor rewording of citations.",
  "- Score 1-2: Fabricated citation, made up statutes/bands/rates, claimed facts contradicting tool output, or hallucinated statutory authority.",
  "Set `hallucinatedCitation: true` if and only if the agent invented or contradicted statutory rules, rates, bands, or effective dates.",
  "",
  "2. `completeness` (1-5):",
  "- For normal calculations: Did the agent state all required statutory numbers asked for in the user prompt (e.g. employee deduction, employer contribution, totals, net pay as applicable to the queried statute), and include the fixed-salary / non-advice disclaimer?",
  "- For refusal/disallowance cases: If the user asked for an action that is statutorily prohibited (e.g. opting out of SKBBK when not allowed) or any tool call returned a statutory refusal/error, the agent's answer MUST clearly explain why the request is disallowed under the statutory rules. If the agent silently ignored the refusal, retried with alternative parameters without explaining the refusal, or failed to address the user's opt-out request, completeness MUST be scored 1 or 2 (never 3, 4, or 5).",
  "- Deduct points if the agent omitted required figures, failed to explain errors, or omitted mandatory disclaimers.",
  "- Do NOT praise or reward employer shares on MTD (PCB) income tax queries; MTD is purely an employee withholding with no employer share.",
  "",
  "3. `clarity` (1-5):",
  "- Score 5: Structured, easy to read, unambiguous labeling of amounts (e.g. RM xx.xx) and statutory bodies (KWSP, PERKESO, LHDN).",
  "- Score 1-3: Confusing layout, ambiguous labels, or hard to distinguish employee from employer amounts.",
  "",
  "Be discriminating: do not default to 5/5/5. Deduct points whenever an answer is incomplete, misleading, unfaithful, or fails to explain a statutory refusal.",
  "Respond ONLY with a valid JSON object matching this schema:",
  '{"citationFaithfulness": <number>, "completeness": <number>, "clarity": <number>, "hallucinatedCitation": <boolean>, "rationale": "<concise explanation>"}',
].join("\n");

const mcpContentBlockSchema = z.object({
  type: z.string(),
  text: z.string(),
});

const mcpCallResultSchema = z.object({
  content: z.array(mcpContentBlockSchema),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

/** Loads and validates eval cases from evals/cases.jsonl and test/golden/cases.json. */
export function loadEvalCases(
  casesJsonlUrl = new URL("./cases.jsonl", import.meta.url),
  goldenJsonUrl = new URL("../test/golden/cases.json", import.meta.url),
): EvalCase[] {
  const jsonlText = readFileSync(casesJsonlUrl, "utf8");
  const rawGolden: unknown = JSON.parse(readFileSync(goldenJsonUrl, "utf8"));
  const parsedGolden = goldenFileSchema.safeParse(rawGolden);
  if (!parsedGolden.success) {
    throw new Error(`Invalid golden cases file: ${parsedGolden.error.message}`);
  }
  return buildEvalCases(parsedGolden.data, parseCasesJsonl(jsonlText));
}

/** Connects an in-memory MCP client to a fresh malaysia-payroll-mcp server instance. */
export async function createInMemoryMcpClient(
  serverModuleSpecifier = "../src/mcp/server.js",
): Promise<Client> {
  const { createServer } = (await import(serverModuleSpecifier)) as {
    createServer: () => McpServer;
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "malaysia-payroll-eval-client", version: VERSION });
  await client.connect(clientTransport);
  return client;
}

/** Runs one eval case through the agent tool-use loop, Layer 1 checks, and Layer 2 judge. */
export async function evaluateSingleCase(params: {
  readonly evalCase: EvalCase;
  readonly mcpClient: Client;
  readonly tools: readonly Tool[];
  readonly llm: LlmClient;
  readonly agentModel: string;
  readonly judgeModel: string;
}): Promise<CaseEvaluation> {
  const startedAt = Date.now();
  const { evalCase, mcpClient, tools, llm, agentModel, judgeModel } = params;
  const { toolCalls, finalAnswer } = await runAgentLoop({
    prompt: evalCase.prompt,
    mcpClient,
    tools,
    llm,
    agentModel,
  });

  const layer1 = evaluateLayer1(evalCase, toolCalls, finalAnswer);
  const judge = await judgeAnswer({
    llm,
    judgeModel,
    input: { caseId: evalCase.id, prompt: evalCase.prompt, toolCalls, finalAnswer },
  });

  return {
    id: evalCase.id,
    prompt: evalCase.prompt,
    expectedTool: evalCase.expectedTool,
    isMustPass: isMustPassCase(evalCase),
    toolCalls,
    finalAnswer,
    layer1,
    layer2: judge.score,
    judgeError: judge.error,
    durationMs: Date.now() - startedAt,
  };
}

/** Runs one seeded bad answer through the real judge and records whether the judge caught it. */
async function evaluateSeededControl(params: {
  readonly control: SeededControl;
  readonly llm: LlmClient;
  readonly judgeModel: string;
}): Promise<ControlEvaluation> {
  const { control, llm, judgeModel } = params;
  const judge = await judgeAnswer({
    llm,
    judgeModel,
    input: {
      caseId: control.id,
      prompt: control.prompt,
      toolCalls: control.toolCalls,
      finalAnswer: control.finalAnswer,
    },
  });
  return {
    id: control.id,
    description: control.description,
    expectation: control.expectation,
    judgment: judge.score,
    judgeError: judge.error,
    isCaught: judge.score !== null && isControlCaught(control, judge.score),
  };
}

async function runAgentLoop(params: {
  readonly prompt: string;
  readonly mcpClient: Client;
  readonly tools: readonly Tool[];
  readonly llm: LlmClient;
  readonly agentModel: string;
}): Promise<{ toolCalls: readonly RecordedToolCall[]; finalAnswer: string }> {
  let messages: MessageParam[] = [{ role: "user", content: params.prompt }];
  let toolCalls: readonly RecordedToolCall[] = [];
  let finalAnswer = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await params.llm.messages.create({
      model: params.agentModel,
      max_tokens: MAX_AGENT_TOKENS,
      temperature: 0,
      system: AGENT_SYSTEM_PROMPT,
      tools: params.tools,
      messages,
    });

    const textParts = extractTextBlocks(response.content);
    const toolUses = extractToolUses(response.content);

    if (toolUses.length === 0) {
      finalAnswer = textParts.join("\n").trim();
      break;
    }

    const { toolResults, recordedCalls } = await executeToolUses(params.mcpClient, toolUses);
    toolCalls = [...toolCalls, ...recordedCalls];
    messages = [
      ...messages,
      { role: "assistant", content: response.content as MessageParam["content"] },
      { role: "user", content: toolResults },
    ];
    if (textParts.length > 0) finalAnswer = textParts.join("\n").trim();
  }
  return { toolCalls, finalAnswer };
}

function extractTextBlocks(content: readonly { type: string; text?: string }[]): string[] {
  return content
    .filter(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text);
}

function extractToolUses(
  content: readonly { type: string; id?: string; name?: string; input?: unknown }[],
): readonly { id: string; name: string; input: Record<string, unknown> }[] {
  return content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input?: unknown } =>
        b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string",
    )
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: isPlainObject(b.input) ? b.input : {},
    }));
}

async function executeToolUses(
  mcpClient: Client,
  toolUses: readonly { id: string; name: string; input: Record<string, unknown> }[],
): Promise<{
  readonly toolResults: ToolResultBlockParam[];
  readonly recordedCalls: readonly RecordedToolCall[];
}> {
  const executed = await Promise.all(
    toolUses.map(async (toolUse) => {
      const rawResult = await mcpClient.callTool({ name: toolUse.name, arguments: toolUse.input });
      const parsed = mcpCallResultSchema.parse(rawResult);
      const textContent = parsed.content
        .map((c) => c.text)
        .join("\n")
        .trim();
      const isError = Boolean(parsed.isError);

      const recordedCall: RecordedToolCall = {
        name: toolUse.name,
        arguments: toolUse.input,
        isError,
        textContent,
        ...(parsed.structuredContent !== undefined
          ? { structuredContent: parsed.structuredContent }
          : {}),
      };
      const toolResult: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: textContent,
        is_error: isError,
      };
      return { recordedCall, toolResult };
    }),
  );

  return {
    toolResults: executed.map((e) => e.toolResult),
    recordedCalls: executed.map((e) => e.recordedCall),
  };
}

function buildJudgeUserMessage(input: JudgeInput): string {
  const serializedCalls = input.toolCalls.map((c) => ({
    tool: c.name,
    arguments: c.arguments,
    isError: c.isError,
    output: c.structuredContent ?? c.textContent,
  }));
  return [
    `Case ID: ${input.caseId}`,
    `User Prompt: ${input.prompt}`,
    "",
    "Tool Calls and Outputs:",
    JSON.stringify(serializedCalls, null, 2),
    "",
    "Agent Final Answer:",
    input.finalAnswer,
  ].join("\n");
}

async function requestJudgement(
  llm: LlmClient,
  judgeModel: string,
  input: JudgeInput,
): Promise<RubricScore> {
  const response = await llm.messages.create({
    model: judgeModel,
    max_tokens: MAX_JUDGE_TOKENS,
    temperature: 0,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildJudgeUserMessage(input) }],
  });
  return parseJudgeResponse(extractTextBlocks(response.content).join("\n"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scores one answer with the judge, retrying a failed call once. A judge that still fails returns
 * an error instead of a score, so the case is excluded from the rubric mean and counted as a judge
 * error rather than a hallucination.
 */
async function judgeAnswer(params: {
  readonly llm: LlmClient;
  readonly judgeModel: string;
  readonly input: JudgeInput;
}): Promise<JudgeOutcome> {
  const { llm, judgeModel, input } = params;
  let lastError = "no attempt was made";
  for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt++) {
    try {
      return { score: await requestJudgement(llm, judgeModel, input), error: null };
    } catch (error: unknown) {
      lastError = describeError(error);
    }
  }
  console.error(
    `Judge evaluation failed for ${input.caseId} after ${JUDGE_MAX_ATTEMPTS} attempts: ${lastError}`,
  );
  return { score: null, error: lastError };
}

/** Validates EVAL_CONCURRENCY as a positive integer. */
export function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid EVAL_CONCURRENCY "${raw}": expected a positive integer.`);
  }
  return parsed;
}

/** Runs the full eval suite with bounded concurrency and returns the scorecard. */
export async function runEvalSuite(options: {
  readonly evalCases: readonly EvalCase[];
  readonly llm: LlmClient;
  readonly controls?: readonly SeededControl[];
  readonly agentModel?: string;
  readonly judgeModel?: string;
  readonly concurrency?: number;
  readonly serverModuleSpecifier?: string;
  readonly thresholds?: GateThresholds;
}): Promise<Scorecard> {
  const agentModel = options.agentModel ?? DEFAULT_ANTHROPIC_MODEL;
  const judgeModel = options.judgeModel ?? DEFAULT_ANTHROPIC_MODEL;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const controls = options.controls ?? loadSeededControls();

  const mcpClient = await createInMemoryMcpClient(options.serverModuleSpecifier);
  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    const anthropicTools: Tool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: String(tool.description),
      input_schema: tool.inputSchema as Tool["input_schema"],
    }));

    const results = await runWorkers({
      evalCases: options.evalCases,
      concurrency,
      mcpClient,
      tools: anthropicTools,
      llm: options.llm,
      agentModel,
      judgeModel,
    });
    const controlResults = await Promise.all(
      controls.map((control) => evaluateSeededControl({ control, llm: options.llm, judgeModel })),
    );

    return buildScorecard({
      cases: results,
      controls: controlResults,
      agentModel,
      judgeModel,
      ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
    });
  } finally {
    await mcpClient.close();
  }
}

async function runWorkers(params: {
  readonly evalCases: readonly EvalCase[];
  readonly concurrency: number;
  readonly mcpClient: Client;
  readonly tools: readonly Tool[];
  readonly llm: LlmClient;
  readonly agentModel: string;
  readonly judgeModel: string;
}): Promise<CaseEvaluation[]> {
  const results = new Array<CaseEvaluation>(params.evalCases.length);
  let nextIndex = 0;

  const worker = async () => {
    for (let current = nextIndex++; current < params.evalCases.length; current = nextIndex++) {
      results[current] = await evaluateSingleCase({
        evalCase: params.evalCases[current] as EvalCase,
        mcpClient: params.mcpClient,
        tools: params.tools,
        llm: params.llm,
        agentModel: params.agentModel,
        judgeModel: params.judgeModel,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(params.concurrency, params.evalCases.length) }, () => worker()),
  );
  return results;
}

/** Writes the JSON and Markdown scorecards to disk (and GITHUB_STEP_SUMMARY when provided). */
export function writeScorecardFiles(
  scorecard: Scorecard,
  outDir = resolve(dirname(fileURLToPath(import.meta.url)), "results"),
  stepSummaryPath?: string,
): { readonly jsonPath: string; readonly markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "scorecard.json");
  const markdownPath = join(outDir, "scorecard.md");
  const markdown = renderScorecardMarkdown(scorecard);

  writeFileSync(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, markdown, "utf8");

  if (stepSummaryPath) {
    appendFileSync(stepSummaryPath, `${markdown}\n`, "utf8");
  }
  return { jsonPath, markdownPath };
}
