export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on tool messages, echoing the tool_call id that produced them. */
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
}

/**
 * The narrow chat interface the review agent depends on. Providers implement
 * this over whatever backend they target (OpenCode local model, Antigravity
 * sidecar, Ollama, ...). Nothing about the type system leaks tool-protocol
 * specifics beyond the OpenAI-compatible shape.
 */
export interface ChatProvider {
  complete(request: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    /** Force a tool call if "required" (otherwise "auto"). */
    toolChoice?: "auto" | "required";
  }): Promise<AssistantTurn>;
}