import { describe, expect, it } from "vitest";
import { runAgent, DEFAULT_MAX_TURNS } from "./agent.js";
import { ChatProvider, AssistantTurn, ToolCall } from "./types.js";
import { QueuedComment, serializeToolResult } from "./tools.js";

class ScriptedProvider implements ChatProvider {
  private readonly queues: AssistantTurn[] = [];
  private calls: number = 0;

  add(turn: AssistantTurn): this {
    this.queues.push(turn);
    return this;
  }

  async complete(): Promise<AssistantTurn> {
    const turn = this.queues[Math.min(this.calls, this.queues.length - 1)];
    this.calls += 1;
    return turn;
  }

  invocationCount(): number {
    return this.calls;
  }
}

const tc = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });

describe("runAgent", () => {
  it("executes tool calls, feeds results back, and returns queued comments", async () => {
    const provider = new ScriptedProvider()
      .add({
        content: null,
        toolCalls: [tc("t1", "create_comment", { path: "a.ts", line: 2, body: "issue" })],
      })
      .add({ content: "Done reviewing.", toolCalls: [] });

    const queue: QueuedComment[] = [];
    const executed: { name: string; args: Record<string, unknown> }[] = [];
    const execute = async (name: string, args: Record<string, unknown>) => {
      executed.push({ name, args });
      if (name === "create_comment") {
        queue.push({ path: String(args.path), line: Number(args.line), body: String(args.body) });
        return { ok: true, value: "queued" } as const;
      }
      return { ok: false, error: "unknown" } as const;
    };

    const result = await runAgent(provider, execute, "sys", "user", { comments: queue });

    expect(executed).toEqual([{ name: "create_comment", args: { path: "a.ts", line: 2, body: "issue" } }]);
    expect(result.comments).toEqual([{ path: "a.ts", line: 2, body: "issue" }]);
    expect(result.summary).toBe("Done reviewing.");
    expect(result.truncated).toBe(false);
    expect(provider.invocationCount()).toBe(2);

    const roles = result.transcript.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    const toolMsg = result.transcript[2];
    expect(toolMsg.toolCallId).toBe("t1");
    expect(toolMsg.role).toBe("tool");
  });

  it("propagates tool execution into the transcript via the executor", async () => {
    const provider = new ScriptedProvider()
      .add({ content: null, toolCalls: [tc("x1", "read_file", { path: "a.ts" })] })
      .add({ content: "done", toolCalls: [] });

    const execute = async (_name: string, _args: Record<string, unknown>) => ({ ok: true, value: "file body" }) as const;
    const result = await runAgent(provider, execute, "sys", "user");
    const toolMessage = result.transcript[2];
    expect(toolMessage).toMatchObject({ role: "tool", content: "file body" });
  });

  it("respects maxTurns and marks truncation", async () => {
    const provider = new ScriptedProvider().add({
      content: null,
      toolCalls: [tc("t", "read_file", { path: "a.ts" })],
    });
    const execute = async () => ({ ok: true, value: "body" }) as const;
    const result = await runAgent(provider, execute, "sys", "user", { maxTurns: 2 });
    expect(result.truncated).toBe(true);
    expect(result.turns).toBe(2);
  });

  it("serializes errors back to the model via the executor result", async () => {
    const provider = new ScriptedProvider()
      .add({ content: null, toolCalls: [tc("e1", "create_comment", { path: "not-changed.ts", line: 1, body: "x" })] })
      .add({ content: "ok", toolCalls: [] });

    const execute = async (_name: string, _args: Record<string, unknown>) => ({ ok: false, error: "not a file changed" }) as const;
    const result = await runAgent(provider, execute, "sys", "user");
    const toolMessage = result.transcript[2];
    expect(toolMessage.content).toBe(serializeToolResult({ ok: false, error: "not a file changed" }));
  });

  it("defaults maxTurns to DEFAULT_MAX_TURNS", () => {
    expect(DEFAULT_MAX_TURNS).toBe(24);
  });
});