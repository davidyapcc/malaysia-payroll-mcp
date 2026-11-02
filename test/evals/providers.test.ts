import { describe, expect, it } from "vitest";
import {
  createAnthropicClient,
  createOpenAiClient,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  resolveProvider,
} from "../../evals/providers.js";
import { parseConcurrency } from "../../evals/runner.js";

describe("Providers and concurrency validation", () => {
  it("validates EVAL_PROVIDER, API keys and EVAL_CONCURRENCY strictly", () => {
    expect(() => resolveProvider({ EVAL_PROVIDER: "typo" })).toThrow(
      'Invalid EVAL_PROVIDER "typo"',
    );
    expect(() => resolveProvider({})).toThrow(
      "Missing API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    );
    expect(() => resolveProvider({ EVAL_PROVIDER: "anthropic" })).toThrow(
      'EVAL_PROVIDER is "anthropic", but ANTHROPIC_API_KEY is not set.',
    );
    expect(() => resolveProvider({ EVAL_PROVIDER: "openai" })).toThrow(
      'EVAL_PROVIDER is "openai", but OPENAI_API_KEY is not set.',
    );

    const anthropicProvider = resolveProvider({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(anthropicProvider.agentModel).toBe(DEFAULT_ANTHROPIC_MODEL);

    const openAiProvider = resolveProvider({ OPENAI_API_KEY: "sk-proj-test" });
    expect(openAiProvider.agentModel).toBe(DEFAULT_OPENAI_MODEL);

    const explicitOpenAi = resolveProvider({
      EVAL_PROVIDER: "openai",
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-proj-test",
      EVAL_AGENT_MODEL: "gpt-4o",
      EVAL_JUDGE_MODEL: "gpt-4o",
    });
    expect(explicitOpenAi.agentModel).toBe("gpt-4o");
    expect(explicitOpenAi.judgeModel).toBe("gpt-4o");

    expect(parseConcurrency(undefined)).toBe(5);
    expect(parseConcurrency("3")).toBe(3);
    expect(() => parseConcurrency("abc")).toThrow('Invalid EVAL_CONCURRENCY "abc"');
    expect(() => parseConcurrency("0")).toThrow('Invalid EVAL_CONCURRENCY "0"');
    expect(() => createOpenAiClient("   ")).toThrow("OPENAI_API_KEY must be a non-empty string.");
  });

  it("dispatches tool-use request and maps OpenAI tool_calls response", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Calling tool...",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "calculate_epf",
                      arguments: JSON.stringify({
                        monthlySalary: 3000,
                        age: 30,
                        citizenship: "malaysian",
                        payPeriod: "2026-11",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = createOpenAiClient("sk-test-openai", mockFetch);
    const first = await client.messages.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      temperature: 0,
      system: "sys",
      tools: [
        {
          name: "calculate_epf",
          description: "desc",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    });

    expect(first.stop_reason).toBe("tool_use");
    expect(first.content[1]).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "calculate_epf",
      input: { monthlySalary: 3000, age: 30, citizenship: "malaysian", payPeriod: "2026-11" },
    });
    expect(capturedBody?.model).toBe("gpt-4o-mini");
    expect(capturedBody?.parallel_tool_calls).toBe(false);
  });

  it("serializes multi-turn assistant messages and tool results to OpenAI format", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Employee RM330.00, Employer RM390.00, Total RM720.00.",
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = createOpenAiClient("sk-test-openai", mockFetch);
    const second = await client.messages.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      temperature: 0,
      system: "sys",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking..." },
            { type: "tool_use", id: "call_1", name: "calculate_epf" },
          ] as never,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_2", name: "calculate_epf" }] as never,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Just text" }] as never,
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "{}" }],
        },
      ],
    });

    expect(second.stop_reason).toBe("end_turn");
    expect(second.content[0]).toEqual({
      type: "text",
      text: "Employee RM330.00, Employer RM390.00, Total RM720.00.",
    });
    expect(capturedBody?.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Thinking...",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "calculate_epf", arguments: "{}" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_2", type: "function", function: { name: "calculate_epf", arguments: "{}" } },
        ],
      },
      { role: "assistant", content: "Just text" },
      { role: "tool", tool_call_id: "call_1", content: "{}" },
    ]);
  });

  it("surfaces OpenAI API HTTP errors", async () => {
    const errorClient = createOpenAiClient(
      "sk-test",
      async () => new Response("bad key", { status: 401 }),
    );
    await expect(
      errorClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("OpenAI API error (401): bad key");
  });

  it("surfaces invalid OpenAI response shape errors", async () => {
    const badShapeClient = createOpenAiClient(
      "sk-test",
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      badShapeClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Invalid OpenAI response shape");
  });

  it("surfaces malformed tool arguments JSON errors", async () => {
    const badArgsClient = createOpenAiClient(
      "sk-test",
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    { id: "c1", function: { name: "calculate_epf", arguments: "{not-json" } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await expect(
      badArgsClient.messages.create({
        model: "gpt-4o-mini",
        max_tokens: 10,
        temperature: 0,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(SyntaxError);
  });

  it("creates an Anthropic client adapter instance with default fetch", () => {
    const client = createAnthropicClient("sk-ant-test");
    expect(client.messages).toBeDefined();
    expect(typeof client.messages.create).toBe("function");
  });

  it("creates an Anthropic client adapter and dispatches messages.create", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Anthropic response" }],
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const client = createAnthropicClient("sk-ant-test", mockFetch);
    expect(client.messages).toBeDefined();
    const result = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 10,
      temperature: 0,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stop_reason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: "Anthropic response" }]);
  });
});
