import { describe, expect, it } from "vitest";
import { extractEmbeddedToolCalls, OpenAiCompatibleProvider, resolveProviderConfig } from "./provider.js";
import { ChatMessage } from "./types.js";

describe("resolveProviderConfig", () => {
  it("defaults to the local OpenAI-compatible endpoint", () => {
    const cfg = resolveProviderConfig({});
    expect(cfg.provider).toBe("auto");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(cfg.model).toBe("qwen2.5-coder:7b");
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
    expect(cfg.provider).toBe("antigravity");
    expect(cfg.apiKey).toBe("secret");
  });
});

describe("OpenAiCompatibleProvider.complete", () => {
  it("posts OpenAI-shaped request and parses assistant text", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello", tool_calls: null } }] }));
    };
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    const turn = await provider.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(turn.content).toBe("hello");
    expect(turn.toolCalls).toEqual([]);
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "m", messages: [{ role: "user", content: "hi" }] });
  });

  it("parses tool_calls and strings the arguments", async () => {
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
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    const turn = await provider.complete({ messages: [], tools: [] });
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "create_comment", arguments: { a: 1 } }]);
  });

  it("encodes assistant tool_calls and tool messages when sending history", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: null } }] }));
    };
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    const history: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "c1", content: "file contents" },
    ];
    await provider.complete({ messages: history });
    const messages = sent?.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "file contents" });
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = async () => new Response("boom", { status: 500 });
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    await expect(provider.complete({ messages: [] })).rejects.toThrow(/500/);
  });

  it("sends tools and the requested tool_choice", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "x", tool_calls: null } }] }),
      );
    };
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "create_comment", description: "d", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
    });
    expect(sent?.tools).toEqual([
      { type: "function", function: { name: "create_comment", description: "d", parameters: { type: "object", properties: {} } } },
    ]);
    expect(sent?.tool_choice).toBe("required");
  });

  it("turns JSON-in-content tool calls into toolCalls", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"name": "create_comment", "arguments": {"path": "a.js", "line": 4, "body": "nit"}}',
                tool_calls: null,
              },
            },
          ],
        }),
      );
    const provider = new OpenAiCompatibleProvider(
      { provider: "auto", baseUrl: "http://x/v1", model: "m" },
      fetchImpl as typeof fetch,
    );
    const turn = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "create_comment", description: "d", parameters: { type: "object", properties: {} } }],
    });
    expect(turn.content).toBe("");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      name: "create_comment",
      arguments: { path: "a.js", line: 4, body: "nit" },
    });
  });
});

describe("extractEmbeddedToolCalls", () => {
  const toolNames = ["create_comment", "read_file"];

  it("parses a single object tool call", () => {
    const calls = extractEmbeddedToolCalls('{"name":"read_file","arguments":{"path":"a.ts"}}', toolNames);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.ts" } });
  });

  it("parses an array of tool calls and stringified arguments", () => {
    const calls = extractEmbeddedToolCalls(
      '[{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"},{"name":"create_comment","arguments":{"line":1}}]',
      toolNames,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments).toEqual({ path: "a.ts" });
    expect(calls[1].arguments).toEqual({ line: 1 });
  });

  it("handles ```json fences", () => {
    const calls = extractEmbeddedToolCalls(
      '```json\n{"name":"create_comment","arguments":{"line":2}}\n```',
      toolNames,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ line: 2 });
  });

  it("ignores plain text and unknown tool names", () => {
    expect(extractEmbeddedToolCalls("just a summary", toolNames)).toEqual([]);
    expect(extractEmbeddedToolCalls('{"name":"rm -rf","arguments":{}}', toolNames)).toEqual([]);
  });

  it("ignores malformed JSON and missing arguments", () => {
    expect(extractEmbeddedToolCalls('{"name": "read_file"', toolNames)).toEqual([]);
    expect(extractEmbeddedToolCalls('{"name":"read_file","arguments":42}', toolNames)).toEqual([]);
  });
});