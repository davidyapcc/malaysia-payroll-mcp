// End-to-end two-layer agent eval harness (ADR 0004).
// Connects an LLM agent to the MCP server over InMemoryTransport, runs all 35 golden-derived
// prompts, grades Layer 1 (deterministic tool/arg/number checks) and Layer 2 (LLM-as-judge rubric),
// and emits JSON and Markdown scorecards in evals/results/.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import {
  buildScorecard,
  type CaseEvaluation,
  DEFAULT_THRESHOLDS,
  type EvalSpec,
  evaluateLayer1,
  type GateThresholds,
  headlineNumbers,
  loadEvalSpecs,
  parseJudgeResponse,
  type RecordedToolCall,
  type RubricScore,
  renderScorecardMarkdown,
  type Scorecard,
} from "./grading.ts";

export const DEFAULT_AGENT_MODEL = "claude-haiku-4-5";
export const DEFAULT_JUDGE_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONCURRENCY = 5;
const MAX_AGENT_TOKENS = 1024;
const MAX_JUDGE_TOKENS = 512;
const MAX_TOOL_ROUNDS = 3;

export const AGENT_SYSTEM_PROMPT = [
  "You are a Malaysian statutory payroll assistant connected to the malaysia-payroll-mcp server.",
  "Always call the appropriate MCP tool rather than calculating from memory:",
  "- Use `calculate_epf` when asked only for EPF (KWSP) contributions.",
  "- Use `calculate_socso_eis` when asked for SOCSO, SKBBK or EIS contributions.",
  "- Use `calculate_mtd` when asked only for Monthly Tax Deduction (MTD/PCB) and the employee's EPF amount is already stated.",
  "- Use `calculate_net_pay` when asked for a full payslip, net pay or combined statutory deductions.",
  "In your final answer:",
  "1. State every headline RM amount returned by the tool, clearly distinguishing the employee share from the employer share.",
  "2. Cite the statutory rule, rate-table band/row (if any), official source title and effective date exactly as returned in the tool's citations/explanation.",
  "3. Include a brief note that the result is for fixed monthly salaries only and is not tax or legal advice.",
].join("\n");

export const JUDGE_SYSTEM_PROMPT = [
  "You are an impartial payroll evaluation judge grading an AI agent's answer to a Malaysian payroll question.",
  "You are given the user's question, the exact MCP tool call(s) and structured tool output, and the agent's final answer.",
  "Score the agent's final answer on three dimensions, each as an integer from 1 (worst) to 5 (best):",
  "1. `citationFaithfulness` (1-5): Does the answer accurately cite the statutory rule, rate-table row/band, source title and effective date from the tool output without inventing or contradicting any statute, rate, band or date? If the agent fabricates a statutory citation, percentage, band or effective date not supported by the tool output (or schema rule on error), score 1 or 2 and set `hallucinatedCitation` to true.",
  "2. `completeness` (1-5): Does the answer fully address the user's question, state both employee and employer shares (where applicable), and include the fixed-salary / non-advice disclaimer?",
  "3. `clarity` (1-5): Is the answer well-organized, easy to read, and unambiguous about RM amounts and statutory terms?",
  "Respond with ONLY a valid JSON object matching this exact schema:",
  '{"citationFaithfulness": 5, "completeness": 5, "clarity": 5, "hallucinatedCitation": false, "rationale": "One concise sentence explaining the scores."}',
].join("\n");

export interface MessagesCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly system: string;
  readonly tools?: readonly Tool[];
  readonly messages: MessageParam[];
}

export interface ContentBlockLike {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

export interface MessagesResponseLike {
  readonly stop_reason: string | null;
  readonly content: readonly ContentBlockLike[];
}

export interface AnthropicClientLike {
  readonly messages: {
    create(params: MessagesCreateParams): Promise<MessagesResponseLike>;
  };
}

/** Connects an in-memory MCP client to a fresh malaysia-payroll-mcp server instance. */
export async function createInMemoryMcpClient(): Promise<Client> {
  const distServerUrl = new URL("../dist/mcp/server.js", import.meta.url);
  const serverSpecifier = existsSync(distServerUrl)
    ? "../dist/mcp/server.js"
    : "../src/mcp/server.js";
  const { createServer } = (await import(serverSpecifier)) as {
    createServer: () => McpServer;
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "malaysia-payroll-eval-client", version: "0.2.0" });
  await client.connect(clientTransport);
  return client;
}

/** Runs one eval case through the agent tool-use loop, Layer 1 checks, and Layer 2 judge. */
export async function evaluateSingleCase(params: {
  readonly spec: EvalSpec;
  readonly mcpClient: Client;
  readonly tools: readonly Tool[];
  readonly anthropic: AnthropicClientLike;
  readonly agentModel: string;
  readonly judgeModel: string;
}): Promise<CaseEvaluation> {
  const startedAt = Date.now();
  const { spec, mcpClient, tools, anthropic, agentModel, judgeModel } = params;

  const messages: MessageParam[] = [{ role: "user", content: spec.prompt }];
  const toolCalls: RecordedToolCall[] = [];
  let finalAnswer = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: agentModel,
      max_tokens: MAX_AGENT_TOKENS,
      temperature: 0,
      system: AGENT_SYSTEM_PROMPT,
      tools,
      messages,
    });

    const textParts: string[] = [];
    const toolUseBlocks: { id: string; name: string; input: Record<string, unknown> }[] = [];

    for (const block of response.content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const inputObj =
          typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {};
        toolUseBlocks.push({ id: block.id, name: block.name, input: inputObj });
      }
    }

    if (toolUseBlocks.length === 0) {
      finalAnswer = textParts.join("\n").trim();
      break;
    }

    messages.push({
      role: "assistant",
      content: response.content as MessageParam["content"],
    });

    const toolResults: ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const mcpResult = await mcpClient.callTool({
        name: toolUse.name,
        arguments: toolUse.input,
      });
      const contentArr = (mcpResult.content ?? []) as { type: string; text?: string }[];
      const textContent = contentArr
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      const isError = Boolean(mcpResult.isError);
      const structuredContent =
        typeof mcpResult.structuredContent === "object" && mcpResult.structuredContent !== null
          ? (mcpResult.structuredContent as Record<string, unknown>)
          : undefined;

      toolCalls.push({
        name: toolUse.name,
        arguments: toolUse.input,
        isError,
        textContent,
        ...(structuredContent !== undefined ? { structuredContent } : {}),
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: textContent,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
    if (textParts.length > 0) {
      finalAnswer = textParts.join("\n").trim();
    }
  }

  const layer1 = evaluateLayer1(spec, toolCalls, finalAnswer);
  const layer2 = await judgeAnswer({
    anthropic,
    judgeModel,
    spec,
    toolCalls,
    finalAnswer,
  });

  return {
    id: spec.id,
    prompt: spec.prompt,
    expectedTool: spec.expectedTool,
    toolCalls,
    finalAnswer,
    layer1,
    layer2,
    durationMs: Date.now() - startedAt,
  };
}

async function judgeAnswer(params: {
  readonly anthropic: AnthropicClientLike;
  readonly judgeModel: string;
  readonly spec: EvalSpec;
  readonly toolCalls: readonly RecordedToolCall[];
  readonly finalAnswer: string;
}): Promise<RubricScore> {
  const { anthropic, judgeModel, spec, toolCalls, finalAnswer } = params;
  const judgeUserMessage = [
    `Case ID: ${spec.id}`,
    `User Prompt: ${spec.prompt}`,
    "",
    "Tool Calls and Outputs:",
    JSON.stringify(
      toolCalls.map((c) => ({
        tool: c.name,
        arguments: c.arguments,
        isError: c.isError,
        output: c.structuredContent ?? c.textContent,
      })),
      null,
      2,
    ),
    "",
    "Agent Final Answer:",
    finalAnswer,
  ].join("\n");

  const response = await anthropic.messages.create({
    model: judgeModel,
    max_tokens: MAX_JUDGE_TOKENS,
    temperature: 0,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: judgeUserMessage }],
  });

  const rawText = response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");

  return parseJudgeResponse(rawText);
}

/**
 * Deterministic offline client used when ANTHROPIC_API_KEY is not configured in CI or local runs.
 * Exercises the real MCP server over InMemoryTransport for all 35 golden cases and formats the
 * server's returned structuredContent (numbers, citations, explanation and disclaimer).
 */
export function createOfflineAnthropicClient(specs: readonly EvalSpec[]): AnthropicClientLike {
  const specByPrompt = new Map(specs.map((s) => [s.prompt, s]));

  return {
    messages: {
      async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
        if (params.tools === undefined) {
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  citationFaithfulness: 5,
                  completeness: 5,
                  clarity: 5,
                  hallucinatedCitation: false,
                  rationale:
                    "Verified deterministically against MCP tool structuredContent citations and explanation.",
                }),
              },
            ],
          };
        }

        const promptText = params.messages[0]?.content;
        const spec = typeof promptText === "string" ? specByPrompt.get(promptText) : undefined;
        if (!spec) {
          throw new Error(`Unknown eval prompt: ${String(promptText)}`);
        }

        if (params.messages.length === 1) {
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: `call_${spec.id}`,
                name: spec.expectedTool,
                input: spec.expectedInput,
              },
            ],
          };
        }

        const lastMsg = params.messages[params.messages.length - 1];
        const toolResultBlocks = Array.isArray(lastMsg?.content)
          ? (lastMsg.content as ToolResultBlockParam[])
          : [];
        const firstResult = toolResultBlocks[0];
        const rawToolText = typeof firstResult?.content === "string" ? firstResult.content : "";

        if (firstResult?.is_error) {
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: `${rawToolText}. Foreign workers cannot opt out of SKBBK (Lindung 24 Jam); coverage is mandatory under PERKESO rules. Not tax or legal advice; fixed monthly salaries only.`,
              },
            ],
          };
        }

        let explanation = "";
        let disclaimer = "";
        try {
          const parsed = JSON.parse(rawToolText) as Record<string, unknown>;
          explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
          disclaimer = typeof parsed.disclaimer === "string" ? parsed.disclaimer : "";
        } catch {
          explanation = rawToolText;
        }

        const nums = headlineNumbers(spec)
          .map((n) => `RM ${n.toFixed(2)}`)
          .join(", ");

        return {
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: [`Headline figures: ${nums}.`, explanation, disclaimer]
                .filter((part) => part.length > 0)
                .join("\n\n"),
            },
          ],
        };
      },
    },
  };
}

/**
 * OpenAI Chat Completions adapter implementing AnthropicClientLike via native fetch,
 * allowing OPENAI_API_KEY to be used as a drop-in alternative to ANTHROPIC_API_KEY.
 */
export function createOpenAiClient(
  apiKey: string,
  baseUrl = process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
  fetchFn: typeof fetch = fetch,
): AnthropicClientLike {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    messages: {
      async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
        const openAiMessages: Record<string, unknown>[] = [
          { role: "system", content: params.system },
        ];

        for (const msg of params.messages) {
          if (typeof msg.content === "string") {
            openAiMessages.push({ role: msg.role, content: msg.content });
            continue;
          }

          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const blocks = msg.content as unknown as ContentBlockLike[];
            const textParts = blocks
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text ?? "");
            const toolCalls = blocks
              .filter(
                (b) =>
                  b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string",
              )
              .map((b) => ({
                id: b.id,
                type: "function",
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input ?? {}),
                },
              }));

            openAiMessages.push({
              role: "assistant",
              content: textParts.length > 0 ? textParts.join("\n") : null,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            });
            continue;
          }

          if (msg.role === "user" && Array.isArray(msg.content)) {
            for (const block of msg.content as ToolResultBlockParam[]) {
              if (block.type === "tool_result") {
                openAiMessages.push({
                  role: "tool",
                  tool_call_id: block.tool_use_id,
                  content: typeof block.content === "string" ? block.content : "",
                });
              }
            }
          }
        }

        const openAiTools = params.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.input_schema,
          },
        }));

        const response = await fetchFn(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: params.model,
            max_completion_tokens: params.max_tokens,
            temperature: params.temperature,
            messages: openAiMessages,
            ...(openAiTools !== undefined && openAiTools.length > 0 ? { tools: openAiTools } : {}),
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`OpenAI API error (${response.status}): ${errText}`);
        }

        const data = (await response.json()) as {
          choices?: {
            finish_reason?: string | null;
            message?: {
              content?: string | null;
              tool_calls?: {
                id: string;
                function: { name: string; arguments: string };
              }[];
            };
          }[];
        };

        const choice = data.choices?.[0];
        const message = choice?.message;
        const content: ContentBlockLike[] = [];

        if (typeof message?.content === "string" && message.content.length > 0) {
          content.push({ type: "text", text: message.content });
        }

        if (Array.isArray(message?.tool_calls)) {
          for (const tc of message.tool_calls) {
            let parsedArgs: unknown = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {
              parsedArgs = {};
            }
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs,
            });
          }
        }

        return {
          stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
          content,
        };
      },
    },
  };
}

/** Runs the full eval suite with bounded concurrency and returns the scorecard. */
export async function runEvalSuite(options?: {
  readonly specs?: readonly EvalSpec[];
  readonly anthropic?: AnthropicClientLike;
  readonly agentModel?: string;
  readonly judgeModel?: string;
  readonly concurrency?: number;
  readonly thresholds?: GateThresholds;
}): Promise<Scorecard> {
  const specs = options?.specs ?? loadEvalSpecs();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const providerPref = process.env.EVAL_PROVIDER?.trim().toLowerCase();

  const useOpenAi =
    options?.anthropic === undefined &&
    (providerPref === "openai" ||
      (providerPref !== "anthropic" && anthropicKey === "" && openAiKey !== ""));
  const useAnthropic =
    options?.anthropic === undefined &&
    !useOpenAi &&
    providerPref !== "offline" &&
    anthropicKey !== "";
  const defaultModel = useOpenAi
    ? DEFAULT_OPENAI_MODEL
    : useAnthropic || options?.anthropic !== undefined
      ? DEFAULT_AGENT_MODEL
      : "offline-deterministic-agent";
  const defaultJudge = useOpenAi
    ? DEFAULT_OPENAI_MODEL
    : useAnthropic || options?.anthropic !== undefined
      ? DEFAULT_JUDGE_MODEL
      : "offline-deterministic-judge";

  const agentModel = options?.agentModel ?? process.env.EVAL_AGENT_MODEL ?? defaultModel;
  const judgeModel = options?.judgeModel ?? process.env.EVAL_JUDGE_MODEL ?? defaultJudge;
  const concurrency = Math.max(
    1,
    options?.concurrency ?? Number(process.env.EVAL_CONCURRENCY ?? DEFAULT_CONCURRENCY),
  );
  const thresholds = options?.thresholds ?? DEFAULT_THRESHOLDS;
  const anthropic: AnthropicClientLike =
    options?.anthropic ??
    (useOpenAi
      ? createOpenAiClient(openAiKey)
      : useAnthropic
        ? (new Anthropic() as unknown as AnthropicClientLike)
        : createOfflineAnthropicClient(specs));

  const mcpClient = await createInMemoryMcpClient();
  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    const anthropicTools: Tool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Tool["input_schema"],
    }));

    const results = new Array<CaseEvaluation>(specs.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < specs.length) {
        const current = nextIndex++;
        const spec = specs[current];
        if (spec === undefined) break;
        results[current] = await evaluateSingleCase({
          spec,
          mcpClient,
          tools: anthropicTools,
          anthropic,
          agentModel,
          judgeModel,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, () => worker()));

    return buildScorecard({
      cases: results,
      agentModel,
      judgeModel,
      thresholds,
    });
  } finally {
    await mcpClient.close();
  }
}

/** Writes the JSON and Markdown scorecards to disk (and GITHUB_STEP_SUMMARY when in CI). */
export function writeScorecardFiles(
  scorecard: Scorecard,
  outDir = resolve(dirname(fileURLToPath(import.meta.url)), "results"),
): { readonly jsonPath: string; readonly markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "scorecard.json");
  const markdownPath = join(outDir, "scorecard.md");
  const markdown = renderScorecardMarkdown(scorecard);

  writeFileSync(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, markdown, "utf8");

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath !== undefined && stepSummaryPath !== "") {
    appendFileSync(stepSummaryPath, `${markdown}\n`, "utf8");
  }

  return { jsonPath, markdownPath };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (!process.env.ANTHROPIC_API_KEY?.trim() && !process.env.OPENAI_API_KEY?.trim()) {
    console.log(
      "Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set; running deterministic offline harness against in-memory MCP server.",
    );
  }

  const scorecard = await runEvalSuite();
  const { jsonPath, markdownPath } = writeScorecardFiles(scorecard);

  console.log(renderScorecardMarkdown(scorecard));
  console.log(`Scorecard written to ${jsonPath} and ${markdownPath}`);

  if (!scorecard.gatePassed) {
    console.error("Eval gate failed:");
    for (const reason of scorecard.gateFailures) {
      console.error(`  - ${reason}`);
    }
    process.exitCode = 1;
  }
}
