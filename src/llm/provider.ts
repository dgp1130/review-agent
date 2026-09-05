import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema, tool } from "ai";
import type { LanguageModel, ModelMessage, Tool as AiTool, ToolSet, TypedToolCall } from "ai";
import { AssistantTurn, ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";

export interface ProviderSettings {
  /** OpenAI-compatible base URL, e.g. https://opencode.ai/zen/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const ENV_BASE_URL_VAR = "REVIEW_AGENT_BASE_URL";
const ENV_MODEL_VAR = "REVIEW_AGENT_MODEL";
const ENV_PROVIDER_VAR = "REVIEW_AGENT_PROVIDER";
const ENV_API_KEY_VAR = "REVIEW_AGENT_API_KEY";
const ENV_GEMINI_API_KEY_VAR = "REVIEW_AGENT_GEMINI_API_KEY";

// OpenCode Zen hosts an OpenAI-compatible gateway at /zen/v1 with no API key
// required for its (rate-limited) anonymous free tier. This is the default.
const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_MODEL = "big-pickle";

// Gemini's official OpenAI-compatibility endpoint (AI Studio). Needs an API
// key via REVIEW_AGENT_GEMINI_API_KEY or GEMINI_API_KEY.
const GEMINI_PROVIDER = "gemini";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_KEY_VAR_FALLBACK = "GEMINI_API_KEY";

export function resolveProviderConfig(env: Record<string, string | undefined> = process.env): ProviderSettings {
  const provider = (env[ENV_PROVIDER_VAR] ?? "auto").trim().toLowerCase();

  if (provider === GEMINI_PROVIDER) {
    const baseUrl = (env[ENV_BASE_URL_VAR] ?? GEMINI_BASE_URL).trim().replace(/\/+$/, "");
    const model = (env[ENV_MODEL_VAR] ?? GEMINI_MODEL).trim();
    const apiKey = (env[ENV_GEMINI_API_KEY_VAR] ?? env[GEMINI_KEY_VAR_FALLBACK])?.trim();
    if (!apiKey) {
      throw new Error(
        `${ENV_GEMINI_API_KEY_VAR} (or ${GEMINI_KEY_VAR_FALLBACK}) is required when ${ENV_PROVIDER_VAR}=${GEMINI_PROVIDER}.`,
      );
    }
    return { baseUrl, model, apiKey };
  }

  const baseUrl = (env[ENV_BASE_URL_VAR] ?? OPENCODE_BASE_URL).trim().replace(/\/+$/, "");
  const model = (env[ENV_MODEL_VAR] ?? OPENCODE_MODEL).trim();
  const apiKey = env[ENV_API_KEY_VAR]?.trim();
  return { baseUrl, model, ...(apiKey && apiKey.length > 0 ? { apiKey } : {}) };
}

/**
 * A ChatProvider backed by any OpenAI-compatible /chat/completions endpoint,
 * implemented over the Vercel AI SDK's `@ai-sdk/openai-compatible` provider.
 * Works with OpenCode Zen, Gemini's OpenAI-compatibility endpoint, or any other
 * OpenAI-compatible service (an opencode server, Ollama, ...). API keys are
 * optional (Zen has a keyless free tier) and come from configuration only.
 */
export class OpenAiCompatibleProvider implements ChatProvider {
  private readonly model: LanguageModel;

  constructor(
    private readonly settings: ProviderSettings,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    const provider = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: settings.baseUrl,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      fetch: fetchImpl,
    });
    this.model = provider.chatModel(settings.model);
  }

  async complete(request: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "required";
  }): Promise<AssistantTurn> {
    const toolDefs = request.tools ?? [];
    const hasTools = toolDefs.length > 0;
    const result = await this.generate({
      messages: request.messages.map((m) => toModelMessage(m)),
      ...(hasTools
        ? {
            tools: Object.fromEntries(toolDefs.map((def) => [def.name, toAiTool(def)])),
            toolChoice: request.toolChoice ?? "auto",
          }
        : {}),
    });
    return { content: result.text, toolCalls: result.toolCalls.map(toToolCall) };
  }

  /**
   * Issues the /chat/completions request via the AI SDK, retrying transient
   * failures (network errors and HTTP 429/5xx) with a small exponential
   * backoff. Fatal errors (4xx other than 429) are surfaced immediately. The
   * AI SDK's own retries are disabled so backoff is not multiplied.
   */
  private async generate(args: {
    messages: ModelMessage[];
    tools?: Record<string, AiTool>;
    toolChoice?: "auto" | "required";
  }): Promise<{ text: string; toolCalls: TypedToolCall<ToolSet>[] }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < LLM_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result = await generateText({
          ...args,
          model: this.model,
          maxRetries: 0,
        });
        return { text: result.text, toolCalls: result.toolCalls ?? [] };
      } catch (err) {
        lastErr = err;
        if (attempt === LLM_RETRY_ATTEMPTS - 1 || !isTransientLlmError(err)) {
          throw new Error(llmErrorMessage(err, this.settings.baseUrl), { cause: err });
        }
        await sleep(LLM_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 50);
      }
    }
    throw lastErr;
  }
}

const LLM_RETRY_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLlmError(err: unknown): boolean {
  if (err instanceof APICallError) {
    return err.isRetryable === true || err.statusCode === 429 || (err.statusCode ?? 0) >= 500;
  }
  return false;
}

function llmErrorMessage(err: unknown, baseUrl: string): string {
  if (err instanceof APICallError) {
    const status = err.statusCode === undefined ? "" : ` (${err.statusCode})`;
    return `LLM request failed${status} against ${baseUrl}: ${err.message || err.responseBody || "unknown error"}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function toToolCall(tc: TypedToolCall<ToolSet>): ToolCall {
  return {
    id: tc.toolCallId,
    name: tc.toolName,
    arguments: (tc.input ?? {}) as Record<string, unknown>,
  };
}

/**
 * Maps a constrained tool definition to an AI SDK tool. The schema is
 * advertised as-is; the decorator keeps the schema JSON-compatible at the
 * domain boundary (integer fields also accept string forms like `"4"` for a
 * line number), matching the executor's tolerant requireInteger coercion.
 */
function toAiTool(def: ToolDefinition): AiTool {
  return tool({
    description: def.description,
    inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
  });
}

/** Maps our chat message into the AI SDK's message model. */
function toModelMessage(m: ChatMessage): ModelMessage {
  if (m.role === "assistant") {
    const content =
      m.toolCalls && m.toolCalls.length > 0
        ? [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments,
            })),
          ]
        : m.content;
    return { role: "assistant", content };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: m.toolCallId ?? "",
          toolName: "",
          output: { type: "text", value: m.content },
        },
      ],
    };
  }
  return { role: m.role, content: m.content };
}