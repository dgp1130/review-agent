import { describe, expect, it } from "vitest";
import { createToolExecutor, QueuedComment, ReviewContext, TOOL_DEFINITIONS, serializeToolResult } from "./tools.js";

class FakeClient {
  private readonly files: Map<string, string>;
  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }
  async rest<T>(_method: string, endpoint: string): Promise<T> {
    const m = /contents\/(.+)\?ref=(.+)$/.exec(endpoint);
    if (!m) {
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
    const path = decodeURIComponent(m[1]);
    const key = `${decodeURIComponent(m[2])}:${path}`;
    const content = this.files.get(key) ?? this.files.get(path);
    if (content === undefined) {
      return { message: "Not Found" } as T;
    }
    return { type: "file", encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") } as T;
  }
}

function context(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    pr: { owner: "dgp1130", repo: "review-agent", number: 10, headSha: "abc123", headOwner: "dgp1130-test", headRepo: "review-agent" },
    isOwnerAllowed: (o) => o === "dgp1130" || o === "acme",
    changedPaths: new Set(["M3-test/format.js", "src/a.ts"]),
    addedLines: new Map([
      ["M3-test/format.js", new Set([1, 3, 5])],
      ["src/a.ts", new Set([2, 4])],
    ]),
    ...overrides,
  };
}

describe("createToolExecutor", () => {
  it("queues a draft comment on an added line of a changed file", async () => {
    const queue: QueuedComment[] = [];
    const exec = createToolExecutor(new FakeClient() as never, context(), queue);
    const result = await exec("create_comment", { path: "M3-test/format.js", line: 3, body: "Consider a null guard." });
    expect(result.ok).toBe(true);
    expect(queue).toEqual([{ path: "M3-test/format.js", line: 3, body: "Consider a null guard." }]);
  });

  it("rejects comments on files not changed in the PR", async () => {
    const queue: QueuedComment[] = [];
    const exec = createToolExecutor(new FakeClient() as never, context(), queue);
    const result = await exec("create_comment", { path: "other.js", line: 1, body: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a file changed/);
    expect(queue).toHaveLength(0);
  });

  it("rejects comments on lines that are not added in the diff", async () => {
    const queue: QueuedComment[] = [];
    const exec = createToolExecutor(new FakeClient() as never, context(), queue);
    const result = await exec("create_comment", { path: "M3-test/format.js", line: 2, body: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not an added line/);
  });

  it("rejects unknown tools", async () => {
    const queue: QueuedComment[] = [];
    const exec = createToolExecutor(new FakeClient() as never, context(), queue);
    const result = await exec("delete_repo", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown tool/);
  });

  it("reads a file from the PR head repo", async () => {
    const client = new FakeClient({ "abc123:M3-test/format.js": "export function truncate() {}" });
    const exec = createToolExecutor(client as never, context(), []);
    const result = await exec("read_file", { path: "M3-test/format.js" });
    expect(result).toEqual({ ok: true, value: "export function truncate() {}" });
  });

  it("rejects path traversal in read_file", async () => {
    const exec = createToolExecutor(new FakeClient() as never, context(), []);
    const result = await exec("read_file", { path: "../etc/passwd" });
    expect(result.ok).toBe(false);
  });

  it("read_other_file rejects non-allowlisted owners", async () => {
    const exec = createToolExecutor(new FakeClient() as never, context(), []);
    const result = await exec("read_other_file", { owner: "evil", repo: "x", path: "a.ts" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not allowlisted/);
  });

  it("read_other_file allows allowlisted owners", async () => {
    const client = new FakeClient({ "HEAD:README.md": "# docs" });
    const exec = createToolExecutor(client as never, context(), []);
    const result = await exec("read_other_file", { owner: "acme", repo: "lib", path: "README.md" });
    expect(result).toEqual({ ok: true, value: "# docs" });
  });

  it("respond_to_comment is stubbed as not supported", async () => {
    const exec = createToolExecutor(new FakeClient() as never, context(), []);
    const result = await exec("respond_to_comment", { commentId: 1, body: "ok" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not yet supported/);
  });

  it("surfaces tool argument validation errors", async () => {
    const exec = createToolExecutor(new FakeClient() as never, context(), []);
    const result = await exec("create_comment", { path: "M3-test/format.js", line: "not-a-number", body: "x" });
    expect(result.ok).toBe(false);
  });
});

describe("TOOL_DEFINITIONS", () => {
  it("exposes exactly the whitelisted tool names", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["read_file", "read_other_file", "create_comment", "respond_to_comment"]);
  });
});

describe("serializeToolResult", () => {
  it("serializes ok and error results", () => {
    expect(serializeToolResult({ ok: true, value: "done" })).toBe("done");
    expect(serializeToolResult({ ok: false, error: "nope" })).toBe("ERROR: nope");
  });
});