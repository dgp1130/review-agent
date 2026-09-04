import { GitHubClient } from "../github/client.js";
import { addedLineNumbers, fetchFileContent } from "../github/diffs.js";
import { ToolDefinition } from "./types.js";

export type ToolResult = { ok: true; value: string } | { ok: false; error: string };

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface QueuedComment {
  path: string;
  line: number;
  body: string;
}

/** Everything the constrained tools need to do their job for one PR. */
export interface ReviewContext {
  pr: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    /** Repo that actually contains the head commit (the fork for fork PRs). */
    headOwner: string;
    headRepo: string;
  };
  /** True when an owner (org/user) is allowlisted for out-of-PR reads. */
  isOwnerAllowed: (owner: string) => boolean;
  /** Paths of files changed by the PR (the only targetable comment paths). */
  changedPaths: Set<string>;
  /** Per-path line numbers added in the diff (the only targetable lines). */
  addedLines: Map<string, Set<number>>;
}

const TOOL_NAMES = ["read_file", "read_other_file", "create_comment", "respond_to_comment"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the full content of a file in the PR as of its head commit. Use this to inspect code you need to review before commenting.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repository-relative path of the file, e.g. src/a.ts" } },
      required: ["path"],
    },
  },
  {
    name: "read_other_file",
    description:
      "Read a file from another repository (only repos owned by the default repo owner or allowlisted orgs). Useful for context that is not part of the PR.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        path: { type: "string", description: "Repository-relative path of the file" },
      },
      required: ["owner", "repo", "path"],
    },
  },
  {
    name: "create_comment",
    description:
      "Queue a draft (pending) review comment on a specific line of a file changed in the PR. Comments are NOT posted to GitHub until your review is complete. The path must be a file changed in the PR and the line must be an added line of that change.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of a file changed in the PR" },
        line: { type: "integer", description: "New-file line number of an added line in the diff" },
        body: { type: "string", description: "The comment text" },
      },
      required: ["path", "line", "body"],
    },
  },
  {
    name: "respond_to_comment",
    description: "Reply to an existing review comment thread. Not yet supported; calling it returns an error.",
    parameters: {
      type: "object",
      properties: {
        commentId: { type: "integer", description: "ID of an existing review comment" },
        body: { type: "string", description: "The reply text" },
      },
      required: ["commentId", "body"],
    },
  },
];

/**
 * Builds the constrained tool executor for one PR review. This is the security
 * boundary: the model can only read files, queue draft comments on changed
 * lines, and (not yet) reply. There is no shell access, no filesystem access,
 * no way to edit or delete existing comments, and no way to submit a review.
 */
export function createToolExecutor(
  client: GitHubClient,
  context: ReviewContext,
  queue: QueuedComment[],
): ToolExecutor {
  return async (name, args): Promise<ToolResult> => {
    if (!isKnownTool(name)) {
      return { ok: false, error: `Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}` };
    }
    try {
      switch (name) {
        case "read_file":
          return await readFile(client, context, args);
        case "read_other_file":
          return await readOtherFile(client, context, args);
        case "create_comment":
          return createComment(context, queue, args);
        case "respond_to_comment":
          return { ok: false, error: "respond_to_comment is not yet supported; do not use it." };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

function isKnownTool(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

async function readFile(client: GitHubClient, ctx: ReviewContext, args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args.path, "path");
  validatePath(path, "read_file");
  const content = await fetchFileContent(client, {
    owner: ctx.pr.headOwner,
    repo: ctx.pr.headRepo,
    path,
    ref: ctx.pr.headSha,
  });
  return { ok: true, value: content };
}

async function readOtherFile(
  client: GitHubClient,
  ctx: ReviewContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const owner = requireString(args.owner, "owner");
  const repo = requireString(args.repo, "repo");
  const path = requireString(args.path, "path");
  if (!ctx.isOwnerAllowed(owner)) {
    return { ok: false, error: `Owner "${owner}" is not allowlisted.` };
  }
  validatePath(path, "read_other_file");
  const content = await fetchFileContent(client, { owner, repo, path, ref: "HEAD" });
  return { ok: true, value: content };
}

function createComment(ctx: ReviewContext, queue: QueuedComment[], args: Record<string, unknown>): ToolResult {
  const path = requireString(args.path, "path");
  const line = requireInteger(args.line, "line");
  const body = requireNonEmptyString(args.body, "body");

  if (!ctx.changedPaths.has(path)) {
    return { ok: false, error: `"${path}" is not a file changed in this PR.` };
  }
  const added = ctx.addedLines.get(path);
  if (!added || !added.has(line)) {
    return {
      ok: false,
      error: `Line ${line} in "${path}" is not an added line of the diff; pick an added line number.`,
    };
  }
  queue.push({ path, line, body });
  return { ok: true, value: `Queued draft comment ${queue.length} on ${path}:${line}. It will be posted as a pending (draft) review when your review completes.` };
}

/** Serializes a tool call's result so the model sees a stable text form. */
export function serializeToolResult(result: ToolResult): string {
  return result.ok ? result.value : `ERROR: ${result.error}`;
}

/**
 * Argument accessors are deliberately tolerant of the loosely typed values LLMs
 * emit via tool calls (e.g. "4" instead of 4 for a number). The constrained
 * surface still rejects anything that cannot be coerced or is out of scope.
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new Error(`Tool argument "${name}" must be a non-empty string.`);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error(`Tool argument "${name}" must be a string.`);
}

export function requireInteger(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?[0-9]+$/.test(value.trim())) {
    return Number(value.trim());
  }
  throw new Error(`Tool argument "${name}" must be an integer.`);
}

export function requireNonEmptyString(value: unknown, name: string): string {
  const s = requireString(value, name);
  if (s.trim() === "") {
    throw new Error(`Tool argument "${name}" must be a non-empty string.`);
  }
  return s;
}

function validatePath(path: string, tool: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes("../") || path === ".." || path.startsWith("~/")) {
    throw new Error(`${tool}: "${path}" is not a valid repository-relative path.`);
  }
}