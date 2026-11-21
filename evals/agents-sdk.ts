// An eval agent built on the OpenAI Agents SDK, graded by the same two-layer eval as the
// hand-rolled loop in runner.ts (ADR 0006).

import type { Client } from "@modelcontextprotocol/client";
import {
  Agent,
  type CallToolResultContent,
  type MCPServer,
  type Model,
  Runner,
} from "@openai/agents-core";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import OpenAI from "openai";
import type { RecordedToolCall } from "./grading.ts";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  type ProviderName,
} from "./providers.ts";
import {
  AGENT_SYSTEM_PROMPT,
  type AgentRun,
  type EvalAgent,
  MAX_AGENT_TOKENS,
  MAX_TOOL_ROUNDS,
  recordToolCall,
} from "./runner.ts";

type MCPTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

const SERVER_NAME = "malaysia-payroll";
/** One retry for a failed run, matching the hand-rolled loop's retry per round. */
const AGENT_MAX_ATTEMPTS = 2;

export const AGENT_IMPLEMENTATIONS = ["loop", "agents-sdk"] as const;
export type AgentImplementation = (typeof AGENT_IMPLEMENTATIONS)[number];

/** Parses EVAL_AGENT_IMPL: "loop" (default, the hand-rolled loop) or "agents-sdk". */
export function parseAgentImplementation(raw: string | undefined): AgentImplementation {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return "loop";
  if (!(AGENT_IMPLEMENTATIONS as readonly string[]).includes(value)) {
    throw new Error(`Invalid EVAL_AGENT_IMPL "${raw}": expected "loop" or "agents-sdk".`);
  }
  return value as AgentImplementation;
}

/**
 * Exposes the eval's in-memory MCP client to the Agents SDK as an `MCPServer`, recording every
 * tool call exactly as the hand-rolled loop does, so both agents are graded on the same data.
 */
export class RecordingMcpServer implements MCPServer {
  readonly name = SERVER_NAME;
  readonly cacheToolsList = false;
  readonly calls: RecordedToolCall[] = [];
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async connect(): Promise<void> {
    // The eval suite owns the client's connection.
  }

  async close(): Promise<void> {
    // The eval suite owns the client's connection.
  }

  async invalidateToolsCache(): Promise<void> {
    // Nothing is cached.
  }

  async listTools(): Promise<MCPTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: {
        ...tool.inputSchema,
        type: "object",
        properties: tool.inputSchema.properties ?? {},
        required: tool.inputSchema.required ?? [],
        additionalProperties: tool.inputSchema.additionalProperties === true,
      },
    }));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
  ): Promise<CallToolResultContent> {
    const toolArgs = args ?? {};
    const rawResult = await this.client.callTool({ name: toolName, arguments: toolArgs });
    const recorded = recordToolCall(toolName, toolArgs, rawResult);
    this.calls.push(recorded);
    // The model sees the same text the hand-rolled loop sends it.
    return [{ type: "text", text: recorded.textContent }] as CallToolResultContent;
  }
}

/** Builds an eval agent that runs each prompt through an Agents SDK `Agent` on `model`. */
export function createAgentsSdkAgent(model: Model): EvalAgent {
  // No traces leave the machine: a local run must not need an OpenAI key.
  const runner = new Runner({ tracingDisabled: true });

  const runOnce = async (prompt: string, mcpClient: Client): Promise<AgentRun> => {
    const server = new RecordingMcpServer(mcpClient);
    const agent = new Agent({
      name: "Malaysian payroll assistant",
      instructions: AGENT_SYSTEM_PROMPT,
      model,
      mcpServers: [server],
      modelSettings: {
        temperature: 0,
        maxTokens: MAX_AGENT_TOKENS,
        parallelToolCalls: false,
      },
    });
    const result = await runner.run(agent, prompt, { maxTurns: MAX_TOOL_ROUNDS });
    // finalOutput is the answer text, or undefined if the run ended without one; join maps that to "".
    return { toolCalls: server.calls, finalAnswer: [result.finalOutput].join("").trim() };
  };

  return async ({ prompt, mcpClient }) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runOnce(prompt, mcpClient);
      } catch (error: unknown) {
        if (attempt >= AGENT_MAX_ATTEMPTS) throw error;
        console.error(
          `Agents SDK run failed (attempt ${attempt}), retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
}

/**
 * Builds the Chat Completions model the Agents SDK agent runs on. Only OpenAI-compatible
 * providers work: OpenAI itself, or a local model through Ollama.
 */
export function createAgentsSdkModel(
  provider: ProviderName,
  model: string,
  env: NodeJS.ProcessEnv,
): Model {
  if (provider === "anthropic") {
    throw new Error(
      'EVAL_AGENT_IMPL="agents-sdk" needs an OpenAI-compatible provider: set EVAL_PROVIDER to "openai" or "ollama".',
    );
  }
  const client =
    provider === "ollama"
      ? new OpenAI({
          // Ollama ignores the key, but the client requires one.
          apiKey: "ollama",
          baseURL: env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL,
        })
      : new OpenAI({
          apiKey: env.OPENAI_API_KEY?.trim() ?? "",
          baseURL: env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
        });
  return new OpenAIChatCompletionsModel(client, model);
}
