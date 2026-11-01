// LLM provider adapters (Anthropic and OpenAI) for the agent eval harness.
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import * as z from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

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

export interface LlmClient {
  readonly messages: {
    create(params: MessagesCreateParams): Promise<MessagesResponseLike>;
  };
}

const openAiToolCallSchema = z.object({
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const openAiResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z.array(openAiToolCallSchema).optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});

/**
 * OpenAI Chat Completions adapter implementing LlmClient via native fetch,
 * allowing OPENAI_API_KEY to be used as an alternative to ANTHROPIC_API_KEY.
 */
export function createOpenAiClient(apiKey: string, fetchFn: typeof fetch = fetch): LlmClient {
  if (apiKey.trim() === "") {
    throw new Error("OPENAI_API_KEY must be a non-empty string.");
  }

  return {
    messages: {
      async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
        const openAiTools = params.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: String(tool.description),
            parameters: tool.input_schema,
          },
        }));

        const response = await fetchFn(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: params.model,
            max_completion_tokens: params.max_tokens,
            temperature: params.temperature,
            messages: toOpenAiMessages(params.system, params.messages),
            ...(openAiTools !== undefined && openAiTools.length > 0
              ? { tools: openAiTools, parallel_tool_calls: false }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);
        }
        return parseOpenAiResponse(await response.json());
      },
    },
  };
}

export function createAnthropicClient(apiKey: string, customFetch?: typeof fetch): LlmClient {
  const anthropic = new Anthropic({
    apiKey,
    ...(customFetch !== undefined ? { fetch: customFetch } : {}),
  });
  return {
    messages: {
      async create(params: MessagesCreateParams): Promise<MessagesResponseLike> {
        const response = await anthropic.messages.create({
          model: params.model,
          max_tokens: params.max_tokens,
          system: params.system,
          tools: params.tools as Tool[],
          messages: params.messages,
        });
        return {
          stop_reason: response.stop_reason,
          content: response.content as ContentBlockLike[],
        };
      },
    },
  };
}

function toOpenAiMessages(
  system: string,
  messages: readonly MessageParam[],
): Record<string, unknown>[] {
  const systemMsg = { role: "system", content: system };
  const converted = messages.flatMap((msg) => {
    if (typeof msg.content === "string") {
      return [{ role: msg.role, content: msg.content }];
    }
    if (msg.role === "assistant") {
      return [convertAssistantBlocks(msg.content as unknown as ContentBlockLike[])];
    }
    return (msg.content as ToolResultBlockParam[]).map((block) => ({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: String(block.content),
    }));
  });
  return [systemMsg, ...converted];
}

function convertAssistantBlocks(blocks: readonly ContentBlockLike[]): Record<string, unknown> {
  const textParts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  const toolCalls = blocks
    .filter((b) => b.type !== "text")
    .map((b) => ({
      id: String(b.id),
      type: "function",
      function: {
        name: String(b.name),
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  return {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function parseOpenAiResponse(rawJson: unknown): MessagesResponseLike {
  const parsed = openAiResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Invalid OpenAI response shape: ${parsed.error.message}`);
  }

  const choice = parsed.data.choices[0];
  const message = choice?.message;
  const textBlocks: ContentBlockLike[] =
    typeof message?.content === "string" && message.content.length > 0
      ? [{ type: "text", text: message.content }]
      : [];
  const toolUseBlocks: ContentBlockLike[] = (message?.tool_calls ?? []).map((tc) => ({
    type: "tool_use",
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as unknown,
  }));

  return {
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    content: [...textBlocks, ...toolUseBlocks],
  };
}

function getModelName(envVal: string | undefined, defaultModel: string): string {
  const trimmed = envVal?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultModel;
}

export interface ResolvedProvider {
  readonly client: LlmClient;
  readonly agentModel: string;
  readonly judgeModel: string;
}

/** Validates provider env vars and returns the configured LLM client and model names. */
export function resolveProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): ResolvedProvider {
  const rawProvider = env.EVAL_PROVIDER?.trim().toLowerCase();
  if (
    rawProvider !== undefined &&
    rawProvider !== "" &&
    rawProvider !== "anthropic" &&
    rawProvider !== "openai"
  ) {
    throw new Error(
      `Invalid EVAL_PROVIDER "${env.EVAL_PROVIDER}": expected "anthropic" or "openai".`,
    );
  }

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  const openAiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const provider =
    rawProvider !== undefined && rawProvider !== ""
      ? rawProvider
      : anthropicKey !== ""
        ? "anthropic"
        : openAiKey !== ""
          ? "openai"
          : undefined;

  if (provider === undefined) {
    throw new Error("Missing API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }
  if (provider === "anthropic") {
    if (anthropicKey === "") {
      throw new Error('EVAL_PROVIDER is "anthropic", but ANTHROPIC_API_KEY is not set.');
    }
    return {
      client: createAnthropicClient(anthropicKey, fetchFn),
      agentModel: getModelName(env.EVAL_AGENT_MODEL, DEFAULT_ANTHROPIC_MODEL),
      judgeModel: getModelName(env.EVAL_JUDGE_MODEL, DEFAULT_ANTHROPIC_MODEL),
    };
  }
  if (openAiKey === "") {
    throw new Error('EVAL_PROVIDER is "openai", but OPENAI_API_KEY is not set.');
  }
  return {
    client: createOpenAiClient(openAiKey, fetchFn),
    agentModel: getModelName(env.EVAL_AGENT_MODEL, DEFAULT_OPENAI_MODEL),
    judgeModel: getModelName(env.EVAL_JUDGE_MODEL, DEFAULT_OPENAI_MODEL),
  };
}
