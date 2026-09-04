import { ChatMessage, ChatProvider } from "./types.js";
import { QueuedComment, serializeToolResult, ToolExecutor } from "./tools.js";
import { TOOL_DEFINITIONS } from "./tools.js";

export interface AgentOptions {
  maxTurns?: number;
  /**
   * The comment queue the constrained executor appends to. Defaults to a fresh
   * array owned by the caller (pass one to share it across runs).
   */
  comments?: QueuedComment[];
  /**
   * Prior conversation to seed the run with (e.g. stored per-PR history from a
   * previous review round), so a re-review builds on what was already said.
   * The fresh user prompt for this round is appended after these messages.
   * Only user/assistant messages should be provided here.
   */
  initialMessages?: ChatMessage[];
}

export interface AgentResult {
  comments: QueuedComment[];
  transcript: ChatMessage[];
  turns: number;
  summary: string | null;
  truncated: boolean;
}

export const DEFAULT_MAX_TURNS = 24;

/**
 * Sent once if the model's first response is text-only (no tool calls at all),
 * to coax it into using the constrained tools. Mechanism-only: it never asserts
 * there are findings, only that findings must be delivered via tools.
 */
const NUDGE =
  "If you identified any issues, deliver each as a create_comment call on an added line of a changed file (use read_file/read_other_file for context first if needed). If everything is fine, just reply with your summary.";

/**
 * Runs the review agent loop: the provider may emit tool calls, each of which
 * is executed against the constrained tool surface, with results fed back to
 * the model. The loop terminates when the model stops requesting tools (or the
 * turn budget is exhausted). Queued draft comments are returned but not posted;
 * posting is owned by the workflow layer (Milestone 4).
 */
export async function runAgent(
  provider: ChatProvider,
  execute: ToolExecutor,
  systemPrompt: string,
  userPrompt: string,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const comments = options.comments ?? [];

  const messages: ChatMessage[] = [...(options.initialMessages ?? []), { role: "user", content: userPrompt }];
  let turns = 0;
  let summary: string | null = null;
  let truncated = false;
  let nudged = false;
  let anyToolExecuted = false;

  for (; turns < maxTurns; turns++) {
    const turn = await provider.complete({
      messages,
      tools: TOOL_DEFINITIONS,
      toolChoice: turns === 0 ? "required" : "auto",
    });

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: turn.content ?? "",
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
    };
    messages.push(assistantMessage);

    if (turn.toolCalls.length === 0) {
      if (!nudged && !anyToolExecuted) {
        messages.push({ role: "user", content: NUDGE });
        nudged = true;
        continue;
      }
      summary = turn.content;
      break;
    }

    for (const toolCall of turn.toolCalls) {
      anyToolExecuted = true;
      const result = await execute(toolCall.name, toolCall.arguments);
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: serializeToolResult(result),
      });
    }
  }

  if (turns >= maxTurns) {
    truncated = true;
  }

  return { comments, transcript: messages, turns, summary, truncated };
}