// LLM provider adapters (Anthropic, OpenAI and Ollama) for the agent eval harness.
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import * as z from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const PROVIDER_NAMES = ["anthropic", "openai", "ollama"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

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
export function createOpenAiClient(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  baseUrl: string = DEFAULT_OPENAI_BASE_URL,
): LlmClient {
  if (apiKey.trim() === "") {
    throw new Error("OPENAI_API_KEY must be a non-empty string.");
  }
  return createChatCompletionsClient({
    url: chatCompletionsUrl(baseUrl),
    headers: { Authorization: `Bearer ${apiKey}` },
    maxTokensField: "max_completion_tokens",
    providerLabel: "OpenAI",
    fetchFn,
  });
}

/**
 * Ollama adapter over its OpenAI-compatible Chat Completions endpoint. Runs open-weight models on
 * the local machine, so it needs no API key and costs nothing per run.
 */
export function createOllamaClient(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  fetchFn: typeof fetch = fetch,
): LlmClient {
  return createChatCompletionsClient({
    url: chatCompletionsUrl(baseUrl),
    headers: {},
    // Ollama's compatibility layer documents max_tokens, not max_completion_tokens.
    maxTokensField: "max_tokens",
    providerLabel: "Ollama",
    fetchFn,
  });
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new Error("Base URL must be a non-empty string.");
  }
  return `${trimmed}/chat/completions`;
}

function createChatCompletionsClient(config: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly providerLabel: string;
  readonly fetchFn: typeof fetch;
}): LlmClient {
  const fetchFn = config.fetchFn;
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

        const response = await fetchFn(config.url, {
          method: "POST",
          headers: {
            ...config.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: params.model,
            [config.maxTokensField]: params.max_tokens,
            temperature: params.temperature,
            messages: toOpenAiMessages(params.system, params.messages),
            ...(openAiTools !== undefined && openAiTools.length > 0
              ? { tools: openAiTools, parallel_tool_calls: false }
              : {}),
          }),
        });

        if (!response.ok) {
          throw new Error(
            `${config.providerLabel} API error (${response.status}): ${await response.text()}`,
          );
        }
        return parseOpenAiResponse(await response.json(), config.providerLabel);
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

/** Removes `<think>...</think>` reasoning that some open-weight models put in the answer text. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

function parseOpenAiResponse(rawJson: unknown, providerLabel: string): MessagesResponseLike {
  const parsed = openAiResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Invalid ${providerLabel} response shape: ${parsed.error.message}`);
  }

  const choice = parsed.data.choices[0];
  const message = choice?.message;
  const answerText = typeof message?.content === "string" ? stripReasoning(message.content) : "";
  const textBlocks: ContentBlockLike[] =
    answerText.length > 0 ? [{ type: "text", text: answerText }] : [];
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
  /** Client the agent runs on. */
  readonly client: LlmClient;
  /** Client the judge runs on: the agent's client unless EVAL_JUDGE_PROVIDER names another. */
  readonly judgeClient: LlmClient;
  readonly agentProvider: ProviderName;
  readonly judgeProvider: ProviderName;
  readonly agentModel: string;
  readonly judgeModel: string;
}

function parseProviderName(raw: string | undefined, envName: string): ProviderName | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (!(PROVIDER_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid ${envName} "${raw}": expected ${PROVIDER_NAMES.map((n) => `"${n}"`).join(", ")}.`,
    );
  }
  return value as ProviderName;
}

const DEFAULT_MODELS: Readonly<Record<ProviderName, string>> = {
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  ollama: DEFAULT_OLLAMA_MODEL,
};

function createClient(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): LlmClient {
  if (provider === "ollama") {
    return createOllamaClient(env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL, fetchFn);
  }
  if (provider === "anthropic") {
    const anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
    if (anthropicKey === "") {
      throw new Error('Provider "anthropic" is selected, but ANTHROPIC_API_KEY is not set.');
    }
    return createAnthropicClient(anthropicKey, fetchFn);
  }
  const openAiKey = env.OPENAI_API_KEY?.trim() ?? "";
  if (openAiKey === "") {
    throw new Error('Provider "openai" is selected, but OPENAI_API_KEY is not set.');
  }
  return createOpenAiClient(
    openAiKey,
    fetchFn,
    env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
  );
}

/**
 * Validates provider env vars and returns the configured LLM clients and model names.
 *
 * EVAL_PROVIDER picks the agent's provider (default: Anthropic if its key is set, else OpenAI if
 * its key is set). EVAL_JUDGE_PROVIDER optionally runs the judge elsewhere, for example a local
 * agent graded by a hosted judge.
 */
export function resolveProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): ResolvedProvider {
  const explicitAgent = parseProviderName(env.EVAL_PROVIDER, "EVAL_PROVIDER");
  const explicitJudge = parseProviderName(env.EVAL_JUDGE_PROVIDER, "EVAL_JUDGE_PROVIDER");

  const agentProvider =
    explicitAgent ??
    (env.ANTHROPIC_API_KEY?.trim()
      ? "anthropic"
      : env.OPENAI_API_KEY?.trim()
        ? "openai"
        : undefined);
  if (agentProvider === undefined) {
    throw new Error(
      'Missing API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or set EVAL_PROVIDER="ollama".',
    );
  }
  const judgeProvider = explicitJudge ?? agentProvider;

  const client = createClient(agentProvider, env, fetchFn);
  const judgeClient =
    judgeProvider === agentProvider ? client : createClient(judgeProvider, env, fetchFn);

  return {
    client,
    judgeClient,
    agentProvider,
    judgeProvider,
    agentModel: getModelName(env.EVAL_AGENT_MODEL, DEFAULT_MODELS[agentProvider]),
    judgeModel: getModelName(env.EVAL_JUDGE_MODEL, DEFAULT_MODELS[judgeProvider]),
  };
}
