import { describe, expect, it } from "vitest";
import { fetchPrFiles, addedLineNumbers, firstAddedLine, fetchFileContent } from "./diffs.js";

class FakeClient {
  constructor(private readonly files: unknown) {}
  async rest<T>(): Promise<T> {
    return this.files as T;
  }
}

describe("fetchPrFiles", () => {
  it("maps PR files and retains the patch", async () => {
    const raw = [
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@ -1 +1 @@\n" },
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3 },
    ];
    const files = await fetchPrFiles(new FakeClient(raw) as never, { owner: "dgp1130", repo: "review-agent", number: 9 });
    expect(files[0]).toMatchObject({ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n" });
    expect(files[1]).toMatchObject({ filename: "M1-test.txt", status: "added" });
  });

  it("normalizes unknown statuses to changed", async () => {
    const files = await fetchPrFiles(new FakeClient([{ filename: "x", status: "weird", additions: 0, deletions: 0, changes: 0 }]) as never, {
      owner: "dgp1130",
      repo: "review-agent",
      number: 9,
    });
    expect(files[0].status).toBe("changed");
  });
});

describe("addedLineNumbers", () => {
  it("collects the added new-side line numbers across hunks", () => {
    const patch = "@@ -1,3 +1,4 @@\n a\n+b\n c\n+ d\n@@ -10,1 +11,1 @@\n x\n+y\n";
    expect([...addedLineNumbers(patch)]).toEqual([2, 4, 12]);
  });

  it("returns empty for a patch with no additions", () => {
    expect(addedLineNumbers("@@ -1,2 +1,2 @@\n a\n b\n").size).toBe(0);
  });
});

describe("firstAddedLine", () => {
  it("returns the first added line across hunks", () => {
    expect(firstAddedLine("@@ -1,3 +1,4 @@\n a\n+b\n c\n@@ -10 +11 @@\n+y\n")).toBe(2);
  });
});

describe("fetchFileContent", () => {
  class FakeClient {
    constructor(private readonly raw: unknown) {}
    async rest<T>(_method: string, endpoint: string): Promise<T> {
      this.endpoint = endpoint;
      return this.raw as T;
    }
    endpoint = "";
  }

  class FakeClient2 {
    constructor(private readonly handler: (endpoint: string) => unknown) {}
    async rest<T>(_method: string, endpoint: string): Promise<T> {
      return this.handler(endpoint) as T;
    }
  }

  it("decodes base64 file contents", async () => {
    const raw = { type: "file", encoding: "base64", content: Buffer.from("hello world").toString("base64") };
    const content = await fetchFileContent(new FakeClient(raw) as never, {
      owner: "dgp1130-test",
      repo: "review-agent",
      path: "M3-test/format.js",
      ref: "abc123",
    });
    expect(content).toBe("hello world");
  });

  it("throws for directories and binary files", async () => {
    await expect(
      fetchFileContent(new FakeClient2(() => [{ name: "a.ts" }]) as never, { owner: "dgp1130-test", repo: "r", path: "dir", ref: "s" }),
    ).rejects.toThrow(/directory/);
    await expect(
      fetchFileContent(new FakeClient2(() => ({ type: "file" })) as never, { owner: "dgp1130-test", repo: "r", path: "bin", ref: "s" }),
    ).rejects.toThrow(/not a text file/);
  });

  it("url-encodes the path and ref in the request", async () => {
    let seen = "";
    await fetchFileContent(new FakeClient2((endpoint) => { seen = endpoint; return { type: "file", encoding: "base64", content: "" }; }) as never, {
      owner: "dgp1130-test",
      repo: "review-agent",
      path: "src/my file.ts",
      ref: "a/b",
    });
    expect(seen).toContain("/contents/src/my%20file.ts?ref=a%2Fb");
  });
});
