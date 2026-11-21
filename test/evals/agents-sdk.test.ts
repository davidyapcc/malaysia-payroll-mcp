import { type Model, type ModelRequest, type ModelResponse, Usage } from "@openai/agents-core";
import { describe, expect, it } from "vitest";
import {
  createAgentsSdkAgent,
  createAgentsSdkModel,
  parseAgentImplementation,
  RecordingMcpServer,
} from "../../evals/agents-sdk.js";
import type { EvalCase } from "../../evals/grading.js";
import { runCli } from "../../evals/run.js";
import {
  AGENT_SYSTEM_PROMPT,
  createInMemoryMcpClient,
  loadEvalCases,
  runEvalSuite,
} from "../../evals/runner.js";
import { agentAnswer, catchingJudgeReply, createFakeLlm } from "./helpers.ts";

function firstCase(): EvalCase {
  const [first] = loadEvalCases();
  if (first === undefined) throw new Error("No eval cases loaded.");
  return first;
}

function message(text: string): ModelResponse["output"][number] {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function functionCall(name: string, args: unknown): ModelResponse["output"][number] {
  return {
    type: "function_call",
    callId: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

/** A model that replays scripted turns and records what the SDK sent it. */
function scriptedModel(turns: readonly (ModelResponse["output"] | Error)[]): {
  readonly model: Model;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const model: Model = {
    async getResponse(request) {
      requests.push(request);
      const turn = turns[requests.length - 1];
      if (turn === undefined) throw new Error("No scripted turn left.");
      if (turn instanceof Error) throw turn;
      return { usage: new Usage(), output: [...turn] };
    },
    getStreamedResponse() {
      throw new Error("Streaming is not used by the eval.");
    },
  };
  return { model, requests };
}

describe("OpenAI Agents SDK eval agent", () => {
  it("parses EVAL_AGENT_IMPL strictly", () => {
    expect(parseAgentImplementation(undefined)).toBe("loop");
    expect(parseAgentImplementation(" ")).toBe("loop");
    expect(parseAgentImplementation("Agents-SDK")).toBe("agents-sdk");
    expect(() => parseAgentImplementation("langgraph")).toThrow(
      'Invalid EVAL_AGENT_IMPL "langgraph": expected "loop" or "agents-sdk".',
    );
  });

  it("calls the MCP tool through the SDK, records it like the loop, and returns the answer", async () => {
    const evalCase = firstCase();
    const { model, requests } = scriptedModel([
      [functionCall(evalCase.expectedTool, evalCase.expectedInput)],
      [message(` ${agentAnswer(evalCase)} `)],
    ]);
    const mcpClient = await createInMemoryMcpClient();
    try {
      const run = await createAgentsSdkAgent(model)({ prompt: evalCase.prompt, mcpClient });

      expect(run.finalAnswer).toBe(agentAnswer(evalCase));
      expect(run.toolCalls).toHaveLength(1);
      expect(run.toolCalls[0]).toMatchObject({
        name: evalCase.expectedTool,
        arguments: evalCase.expectedInput,
        isError: false,
      });
      expect(run.toolCalls[0]?.structuredContent).toBeDefined();

      expect(requests[0]?.systemInstructions).toBe(AGENT_SYSTEM_PROMPT);
      expect(requests[0]?.modelSettings).toMatchObject({
        temperature: 0,
        maxTokens: 1024,
        parallelToolCalls: false,
      });
      expect(requests[0]?.tools.map((t) => t.name)).toContain(evalCase.expectedTool);
    } finally {
      await mcpClient.close();
    }
  });

  it("retries a failed run once, then rethrows so the case becomes an agent error", async () => {
    const evalCase = firstCase();
    const mcpClient = await createInMemoryMcpClient();
    try {
      const recovering = scriptedModel([new Error("connection refused"), [message("Answer")]]);
      const run = await createAgentsSdkAgent(recovering.model)({
        prompt: evalCase.prompt,
        mcpClient,
      });
      expect(run).toEqual({ toolCalls: [], finalAnswer: "Answer" });

      const nonError: Model = {
        getResponse: () => Promise.reject("socket hang up"),
        getStreamedResponse() {
          throw new Error("unused");
        },
      };
      await expect(
        createAgentsSdkAgent(nonError)({ prompt: evalCase.prompt, mcpClient }),
      ).rejects.toBeDefined();

      const failing = scriptedModel([new Error("first"), "nope" as never]);
      await expect(
        createAgentsSdkAgent(failing.model)({ prompt: evalCase.prompt, mcpClient }),
      ).rejects.toThrow();
    } finally {
      await mcpClient.close();
    }
  });

  it("exposes tools and records refused calls through RecordingMcpServer", async () => {
    const mcpClient = await createInMemoryMcpClient();
    try {
      const server = new RecordingMcpServer(mcpClient);
      await server.connect();
      await server.invalidateToolsCache();
      const tools = await server.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["calculate_epf", "calculate_net_pay"]),
      );
      expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);

      const content = await server.callTool("calculate_epf", null);
      expect(server.calls[0]).toMatchObject({
        name: "calculate_epf",
        arguments: {},
        isError: true,
      });
      expect(content).toEqual([{ type: "text", text: server.calls[0]?.textContent }]);
      await server.close();
    } finally {
      await mcpClient.close();
    }
  });

  it("maps tools without a description or schema properties", async () => {
    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "bare",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
      }),
    };
    const server = new RecordingMcpServer(fakeClient as never);
    expect(await server.listTools()).toEqual([
      {
        name: "bare",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
      },
    ]);
  });

  it("runs the whole suite with the SDK agent in place of the loop", async () => {
    const evalCase = firstCase();
    const { model } = scriptedModel([
      [functionCall(evalCase.expectedTool, evalCase.expectedInput)],
      [message(agentAnswer(evalCase))],
    ]);
    const judge = createFakeLlm({ evalCases: [evalCase], judgeReply: catchingJudgeReply([]) });

    const scorecard = await runEvalSuite({
      evalCases: [evalCase],
      llm: judge,
      agent: createAgentsSdkAgent(model),
      controls: [],
    });

    expect(scorecard.cases[0]?.layer1.isPassed).toBe(true);
    expect(scorecard.agentErrors).toBe(0);
  });

  it("builds Chat Completions models for OpenAI and Ollama, and refuses Anthropic", () => {
    expect(createAgentsSdkModel("ollama", "qwen3:8b", {})).toBeDefined();
    expect(
      createAgentsSdkModel("ollama", "qwen3:8b", { OLLAMA_BASE_URL: "http://box:11434/v1" }),
    ).toBeDefined();
    expect(createAgentsSdkModel("openai", "gpt-4o", { OPENAI_API_KEY: "sk-test" })).toBeDefined();
    expect(() => createAgentsSdkModel("openai", "gpt-4o", {})).toThrow();
    expect(
      createAgentsSdkModel("openai", "gpt-4o", {
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "https://proxy.example/v1",
      }),
    ).toBeDefined();
    expect(() => createAgentsSdkModel("anthropic", "claude-haiku-4-5", {})).toThrow(
      'EVAL_AGENT_IMPL="agents-sdk" needs an OpenAI-compatible provider',
    );
  });

  it("rejects an Agents SDK run on Anthropic from the CLI before any model call", async () => {
    await expect(
      runCli({ ANTHROPIC_API_KEY: "sk-ant-test", EVAL_AGENT_IMPL: "agents-sdk" }),
    ).rejects.toThrow('EVAL_AGENT_IMPL="agents-sdk" needs an OpenAI-compatible provider');
  });
});
