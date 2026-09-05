import { AssistantTurn, ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";

export interface ProviderSettings {
  /** Informational: which backend flavor this resolves to. */
  provider: string;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const ENV_BASE_URL_VAR = "REVIEW_AGENT_BASE_URL";
const ENV_MODEL_VAR = "REVIEW_AGENT_MODEL";
const ENV_PROVIDER_VAR = "REVIEW_AGENT_PROVIDER";
const ENV_API_KEY_VAR = "REVIEW_AGENT_API_KEY";

// Defaults verified to work in the local dev environment (Ollama on 11434 with
// qwen2.5-coder:7b). Point REVIEW_AGENT_BASE_URL / REVIEW_AGENT_MODEL at any
// OpenAI-compatible endpoint (an opencode server or Antigravity sidecar) to use
// those instead. Both real tool_calls and JSON-in-content tool calls are handled.
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "qwen2.5-coder:7b";

export function resolveProviderConfig(env: Record<string, string | undefined> = process.env): ProviderSettings {
  const provider = (env[ENV_PROVIDER_VAR] ?? "auto").trim().toLowerCase();
  const baseUrl = (env[ENV_BASE_URL_VAR] ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const model = (env[ENV_MODEL_VAR] ?? DEFAULT_MODEL).trim();
  const apiKey = env[ENV_API_KEY_VAR]?.trim();
  return { provider, baseUrl, model, ...(apiKey && apiKey.length > 0 ? { apiKey } : {}) };
}

interface OpenAiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface OpenAiChoice {
  message: { content: string | null; tool_calls?: OpenAiToolCall[] | null };
  finish_reason: string;
}

interface OpenAiChatResponse {
  choices: OpenAiChoice[];
}

/**
 * A ChatProvider backed by any OpenAI-compatible /chat/completions endpoint.
 * Works with the local Ollama service, an opencode server, or an Antigravity
 * sidecar (all expose this protocol). No API-key management is performed;
 * credentials come from configuration only.
 */
export class OpenAiCompatibleProvider implements ChatProvider {
  constructor(
    private readonly settings: ProviderSettings,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async complete(request: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "required";
  }): Promise<AssistantTurn> {
    const toolDefs = request.tools ?? [];
    const hasTools = toolDefs.length > 0;
    const response = await this.request(hasTools ? request.toolChoice ?? "auto" : undefined, toolDefs, request.messages);

    const payload = (await response.json()) as OpenAiChatResponse;
    const choice = payload.choices[0];
    if (!choice) {
      throw new Error("LLM response contained no choices.");
    }
    const toolNames = toolDefs.map((t) => t.name);
    const rawToolCalls = (choice.message.tool_calls ?? []).map(toToolCall);
    const embeddedToolCalls =
      rawToolCalls.length === 0 ? extractEmbeddedToolCalls(choice.message.content, toolNames) : [];
    return {
      content: embeddedToolCalls.length === 0 ? choice.message.content : "",
      toolCalls: rawToolCalls.length > 0 ? rawToolCalls : embeddedToolCalls,
    };
  }

  /**
   * Issues the /chat/completions request, retrying transient failures (network
   * errors and HTTP 429/5xx) with a small exponential backoff. Fatal errors
   * (4xx other than 429) are surfaced immediately.
   */
  private async request(
    toolChoice: "auto" | "required" | undefined,
    toolDefs: ToolDefinition[],
    messages: ChatMessage[],
  ): Promise<Response> {
    const url = `${this.settings.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.settings.model,
      messages: messages.map(toOpenAiMessage),
      ...(toolDefs.length > 0
        ? {
            tools: toolDefs.map(toOpenAiTool),
            tool_choice: toolChoice ?? "auto",
          }
        : {}),
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt < LLM_RETRY_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {}),
          },
          body,
        });
      } catch (err) {
        lastErr = err;
        if (attempt === LLM_RETRY_ATTEMPTS - 1) {
          throw err;
        }
        await sleep(LLM_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 50);
        continue;
      }

      if (response.ok) {
        return response;
      }
      const detail = await response.text().catch(() => "");
      if (!isLlmTransient(response.status, detail)) {
        throw new Error(
          `LLM request failed (${response.status}) against ${this.settings.baseUrl}: ${detail.slice(0, 300)}`,
        );
      }
      lastErr = new Error(
        `LLM request failed (${response.status}) against ${this.settings.baseUrl}: ${detail.slice(0, 300)}`,
      );
      if (attempt === LLM_RETRY_ATTEMPTS - 1) {
        throw lastErr;
      }
      await sleep(LLM_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 50);
    }
    throw lastErr;
  }
}

const LLM_RETRY_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLlmTransient(status: number, detail: string): boolean {
  if (status === 429 || status >= 500) {
    return true;
  }
  return /timed? ?out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|failed to connect/i.test(detail);
}

function toToolCall(tc: OpenAiToolCall): ToolCall {
  return {
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
  };
}

/**
 * Some OpenAI-compatible backends (e.g. Ollama's text-mode function calling for
 * models without native tool support, such as qwen2.5-coder) emit tool calls as
 * a JSON object in the `content` field instead of a `tool_calls` array. Accept
 * that style too: a single object or an array of objects of the shape
 * `{"name": "...", "arguments": {...|"..."}}`, optionally fenced in ```json.
 * Returns [] when the content is not a recognized tool call.
 */
export function extractEmbeddedToolCalls(content: string | null, toolNames: string[]): ToolCall[] {
  if (!content) {
    return [];
  }
  let text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced) {
    text = fenced[1].trim();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const candidates = Array.isArray(value) ? value : [value];
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const obj = candidate as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== "string" || !toolNames.includes(name)) {
      continue;
    }
    let args: Record<string, unknown>;
    if (typeof obj.arguments === "string") {
      try {
        args = JSON.parse(obj.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }
    } else if (typeof obj.arguments === "object" && obj.arguments !== null) {
      args = obj.arguments as Record<string, unknown>;
    } else {
      continue;
    }
    calls.push({ id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args });
  }
  return calls;
}

function toOpenAiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}