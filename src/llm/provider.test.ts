import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider, resolveProviderConfig } from "./provider.js";
import { ChatMessage } from "./types.js";

const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";

function provider(fetchImpl: typeof fetch): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({ baseUrl: "http://x/v1", model: "m" }, fetchImpl);
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: null } }] }));
}

describe("resolveProviderConfig", () => {
  it("defaults to the OpenCode Zen endpoint with no API key", () => {
    const cfg = resolveProviderConfig({});
    expect(cfg.baseUrl).toBe(OPENCODE_BASE_URL);
    expect(cfg.model).toBe("big-pickle");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("honors env overrides and strips trailing slashes", () => {
    const cfg = resolveProviderConfig({
      REVIEW_AGENT_BASE_URL: "http://example.com/v1/",
      REVIEW_AGENT_MODEL: "gpt-x",
      REVIEW_AGENT_PROVIDER: "antigravity",
      REVIEW_AGENT_API_KEY: "secret",
    });
    expect(cfg.baseUrl).toBe("http://example.com/v1");
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.apiKey).toBe("secret");
  });

  it("resolves gemini to its OpenAI-compatible endpoint with a key", () => {
    const cfg = resolveProviderConfig({
      REVIEW_AGENT_PROVIDER: "gemini",
      REVIEW_AGENT_GEMINI_API_KEY: "gkey",
    });
    expect(cfg.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(cfg.model).toBe("gemini-3.5-flash");
    expect(cfg.apiKey).toBe("gkey");
  });

  it("falls back to the standard GEMINI_API_KEY env var", () => {
    const cfg = resolveProviderConfig({ REVIEW_AGENT_PROVIDER: "gemini", GEMINI_API_KEY: "gkey" });
    expect(cfg.apiKey).toBe("gkey");
  });

  it("requires an API key for gemini", () => {
    expect(() => resolveProviderConfig({ REVIEW_AGENT_PROVIDER: "gemini" })).toThrow(/REVIEW_AGENT_GEMINI_API_KEY/);
  });
});

describe("OpenAiCompatibleProvider.complete", () => {
  it("posts OpenAI-shaped request and parses assistant text", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calls.push({ url, body });
      return textResponse("hello");
    };
    const turn = await provider(fetchImpl as typeof fetch).complete({ messages: [{ role: "user", content: "hi" }] });

    expect(turn.content).toBe("hello");
    expect(turn.toolCalls).toEqual([]);
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "m", messages: [{ role: "user", content: "hi" }] });
  });

  it("parses tool_calls and parses the arguments", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "create_comment", arguments: '{"a":1}' } },
                ],
              },
            },
          ],
        }),
      );
    const turn = await provider(fetchImpl).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "create_comment", arguments: { a: 1 } }]);
  });

  it("encodes assistant tool_calls and tool messages when sending history", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as Record<string, unknown>;
      return textResponse("ok");
    };
    const history: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", content: "file contents" },
    ];
    await provider(fetchImpl as typeof fetch).complete({ messages: history });
    const messages = sent?.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "file contents" });
  });

  it("throws on fatal 4xx responses without retrying", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("boom", { status: 404 });
    };
    await expect(provider(fetchImpl).complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("retries transient 5xx responses and succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("overloaded", { status: 503 });
      }
      return textResponse("recovered");
    };
    const turn = await provider(fetchImpl).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(turn.content).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("retries network failures then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new TypeError("fetch failed");
        err.cause = new Error("connect ECONNREFUSED 127.0.0.1:11434");
        throw err;
      }
      return textResponse("ok");
    };
    const turn = await provider(fetchImpl).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(turn.content).toBe("ok");
    expect(calls).toBe(2);
  });

  it("sends tools and the requested tool_choice", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "create_comment", arguments: "{}" } }],
              },
            },
          ],
        }),
      );
    };
    await provider(fetchImpl as typeof fetch).complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "create_comment", description: "d", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
    });
    expect(sent?.tools).toEqual([
      { type: "function", function: { name: "create_comment", description: "d", parameters: { type: "object", properties: {} } } },
    ]);
    expect(sent?.tool_choice).toBe("required");
  });
});