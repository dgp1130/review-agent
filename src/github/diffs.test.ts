import { describe, expect, it } from "vitest";
import { fetchPrFiles } from "./diffs.js";

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
