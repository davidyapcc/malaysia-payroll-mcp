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
  buildEvalCases,
  buildScorecard,
  type CaseEvaluation,
  type EvalCase,
  evaluateLayer1,
  goldenFileSchema,
  MIN_RUBRIC_SCORE,
  parseCasesJsonl,
  parseJudgeResponse,
  type RecordedToolCall,
  type RubricScore,
  renderScorecardMarkdown,
  type Scorecard,
} from "./grading.ts";
import { DEFAULT_ANTHROPIC_MODEL, type LlmClient } from "./providers.ts";

const DEFAULT_CONCURRENCY = 5;
const MAX_AGENT_TOKENS = 1024;
const MAX_JUDGE_TOKENS = 512;
const MAX_TOOL_ROUNDS = 3;

export const AGENT_SYSTEM_PROMPT = [
  "You are a Malaysian statutory payroll assistant connected to the malaysia-payroll-mcp server.",
  "Always call a single MCP tool that directly answers the user's question rather than calling multiple tools or calculating from memory.",
  "If a tool call returns a validation or domain error, do not retry with different arguments; explain the error directly to the user.",
  "In your final answer:",
  "1. State every RM figure returned by the tool formatted as RM with two decimal places (for example RM550.00), including employee share, employer share, totals, net pay, total deductions, total employer contributions and total employer cost where present in the tool output.",
  "2. Cite the statutory rule, rate-table band/row (if any), official source title and effective date exactly as returned in the tool's citations/explanation.",
  "3. Include a brief note that the result is for fixed monthly salaries only and is not tax or legal advice.",
].join("\n");

export const JUDGE_SYSTEM_PROMPT = [
  "You are an impartial payroll evaluation judge grading an AI agent's answer to a Malaysian payroll question.",
  "You are given the user's question, the exact MCP tool call(s) and structured tool output, and the agent's final answer.",
  "Score the agent's final answer on three dimensions, each as an integer from 1 (worst) to 5 (best):",
  "1. `citationFaithfulness` (1-5): Does the answer accurately cite the statutory rule, rate-table row/band, source title and effective date from the tool output without inventing or contradicting any statute, rate, band or date? If the agent fabricates a statutory citation, percentage, band or effective date not supported by the tool output, score 1 or 2 and set `hallucinatedCitation` to true.",
  "2. `completeness` (1-5): Does the answer fully address the user's question, state the employee, employer and total shares (where applicable), and include the fixed-salary / non-advice disclaimer?",
  "3. `clarity` (1-5): Is the answer well-organized, easy to read, and unambiguous about RM amounts and statutory terms?",
  "Respond with ONLY a valid JSON object matching this exact schema:",
  '{"citationFaithfulness": 5, "completeness": 5, "clarity": 5, "hallucinatedCitation": false, "rationale": "One concise sentence explaining the scores."}',
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
  const layer2 = await judgeAnswer({ llm, judgeModel, evalCase, toolCalls, finalAnswer });

  return {
    id: evalCase.id,
    prompt: evalCase.prompt,
    expectedTool: evalCase.expectedTool,
    toolCalls,
    finalAnswer,
    layer1,
    layer2,
    durationMs: Date.now() - startedAt,
  };
}

async function runAgentLoop(params: {
  readonly prompt: string;
  readonly mcpClient: Client;
  readonly tools: readonly Tool[];
  readonly llm: LlmClient;
  readonly agentModel: string;
}): Promise<{ toolCalls: RecordedToolCall[]; finalAnswer: string }> {
  const messages: MessageParam[] = [{ role: "user", content: params.prompt }];
  const toolCalls: RecordedToolCall[] = [];
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

    messages.push({ role: "assistant", content: response.content as MessageParam["content"] });
    const toolResults = await executeToolUses(params.mcpClient, toolUses, toolCalls);
    messages.push({ role: "user", content: toolResults });
    if (textParts.length > 0) finalAnswer = textParts.join("\n").trim();
  }
  return { toolCalls, finalAnswer };
}

function extractTextBlocks(content: readonly { type: string; text?: string }[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
}

function extractToolUses(
  content: readonly { type: string; id?: string; name?: string; input?: unknown }[],
): { id: string; name: string; input: Record<string, unknown> }[] {
  const uses: { id: string; name: string; input: Record<string, unknown> }[] = [];
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      const inputObj =
        typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      uses.push({ id: block.id, name: block.name, input: inputObj });
    }
  }
  return uses;
}

async function executeToolUses(
  mcpClient: Client,
  toolUses: readonly { id: string; name: string; input: Record<string, unknown> }[],
  recorded: RecordedToolCall[],
): Promise<ToolResultBlockParam[]> {
  const results: ToolResultBlockParam[] = [];
  for (const toolUse of toolUses) {
    const rawResult = await mcpClient.callTool({ name: toolUse.name, arguments: toolUse.input });
    const parsed = mcpCallResultSchema.parse(rawResult);
    const textContent = parsed.content
      .map((c) => c.text)
      .join("\n")
      .trim();
    const isError = Boolean(parsed.isError);

    recorded.push({
      name: toolUse.name,
      arguments: toolUse.input,
      isError,
      textContent,
      ...(parsed.structuredContent !== undefined
        ? { structuredContent: parsed.structuredContent }
        : {}),
    });
    results.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: textContent,
      is_error: isError,
    });
  }
  return results;
}

async function judgeAnswer(params: {
  readonly llm: LlmClient;
  readonly judgeModel: string;
  readonly evalCase: EvalCase;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalAnswer: string;
}): Promise<RubricScore> {
  const { llm, judgeModel, evalCase, toolCalls, finalAnswer } = params;
  const serializedCalls = toolCalls.map((c) => ({
    tool: c.name,
    arguments: c.arguments,
    isError: c.isError,
    output: c.structuredContent ?? c.textContent,
  }));
  const judgeUserMessage = [
    `Case ID: ${evalCase.id}`,
    `User Prompt: ${evalCase.prompt}`,
    "",
    "Tool Calls and Outputs:",
    JSON.stringify(serializedCalls, null, 2),
    "",
    "Agent Final Answer:",
    finalAnswer,
  ].join("\n");

  try {
    const response = await llm.messages.create({
      model: judgeModel,
      max_tokens: MAX_JUDGE_TOKENS,
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: judgeUserMessage }],
    });
    const rawText = extractTextBlocks(response.content).join("\n");
    return parseJudgeResponse(rawText);
  } catch (error) {
    return {
      citationFaithfulness: MIN_RUBRIC_SCORE,
      completeness: MIN_RUBRIC_SCORE,
      clarity: MIN_RUBRIC_SCORE,
      hasHallucinatedCitation: true,
      rationale: `Judge evaluation failed: ${(error as Error).message}`,
    };
  }
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
  readonly agentModel?: string;
  readonly judgeModel?: string;
  readonly concurrency?: number;
  readonly serverModuleSpecifier?: string;
}): Promise<Scorecard> {
  const agentModel = options.agentModel ?? DEFAULT_ANTHROPIC_MODEL;
  const judgeModel = options.judgeModel ?? DEFAULT_ANTHROPIC_MODEL;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

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

    return buildScorecard({
      cases: results,
      agentModel,
      judgeModel,
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

/** Writes the JSON and Markdown scorecards to disk (and GITHUB_STEP_SUMMARY when in CI). */
export function writeScorecardFiles(
  scorecard: Scorecard,
  outDir = resolve(dirname(fileURLToPath(import.meta.url)), "results"),
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY,
): { readonly jsonPath: string; readonly markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "scorecard.json");
  const markdownPath = join(outDir, "scorecard.md");
  const markdown = renderScorecardMarkdown(scorecard);

  writeFileSync(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, markdown, "utf8");

  if (stepSummaryPath !== undefined && stepSummaryPath !== "") {
    appendFileSync(stepSummaryPath, `${markdown}\n`, "utf8");
  }
  return { jsonPath, markdownPath };
}
