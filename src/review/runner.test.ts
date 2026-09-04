import { describe, expect, it } from "vitest";
import { isEligible, evaluateSinglePr, reviewSinglePr, firstAddedLine, buildFixtureComments } from "./runner.js";
import { PullRequestInfo } from "../github/prs.js";
import { emptyState, makePrRecord, prKey } from "../state/types.js";
import { PrFile } from "../github/diffs.js";

function info(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    owner: "dgp1130",
    repo: "review-agent",
    number: 1,
    title: "t",
    state: "OPEN",
    isCrossRepository: false,
    headRefOid: "sha1",
    isReviewRequested: false,
    isAssignee: false,
    ...overrides,
  };
}

/** Raw shape returned by the GraphQL `fetchPrByRef` query. */
type RawNode = Omit<PullRequestInfo, "isReviewRequested" | "isAssignee"> & {
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  assignees: { nodes: { login?: string }[] };
  repository: { name: string; owner: { login: string } };
};

function rawNode(p: PullRequestInfo): RawNode {
  return {
    owner: p.owner,
    repo: p.repo,
    number: p.number,
    title: p.title,
    state: p.state,
    isCrossRepository: p.isCrossRepository,
    headRefOid: p.headRefOid,
    reviewRequests: {
      nodes: p.isReviewRequested ? [{ requestedReviewer: { login: "dgp1130" } }] : [],
    },
    assignees: { nodes: p.isAssignee ? [{ login: "dgp1130" }] : [] },
    repository: { name: p.repo, owner: { login: p.owner } },
  };
}

describe("isEligible", () => {
  it("is true for an open, non-fork PR involving the user", () => {
    expect(isEligible(info({ isReviewRequested: true }))).toBe(true);
    expect(isEligible(info({ isAssignee: true }))).toBe(true);
  });

  it("is false for closed PRs", () => {
    expect(isEligible(info({ state: "CLOSED", isReviewRequested: true }))).toBe(false);
  });

  it("allows fork (cross-repository) PRs when the user is involved", () => {
    expect(isEligible(info({ isCrossRepository: true, isReviewRequested: true }))).toBe(true);
  });

  it("is false when the user is neither reviewer nor assignee", () => {
    expect(isEligible(info({ isReviewRequested: false, isAssignee: false }))).toBe(false);
  });
});

describe("evaluateSinglePr", () => {
  class FakeClient {
    constructor(private readonly node: RawNode | null) {}
    async graphql(): Promise<{ repository: { pullRequest: RawNode | null } }> {
      return { repository: { pullRequest: this.node } };
    }
  }

  it("reports not found for a missing PR", async () => {
    const outcome = await evaluateSinglePr(new FakeClient(null) as never, { owner: "a", repo: "b", number: 9 }, "dgp1130", emptyState());
    expect(outcome.shouldReview).toBe(false);
    expect(outcome.reason).toMatch(/not found/);
  });

  it("returns shouldReview when the head has not been reviewed", async () => {
    const outcome = await evaluateSinglePr(
      new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "sha9" }))) as never,
      { owner: "dgp1130", repo: "review-agent", number: 1 },
      "dgp1130",
      emptyState(),
    );
    expect(outcome.shouldReview).toBe(true);
  });

  it("returns shouldReview=false when already reviewed at head", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 1)] = makePrRecord("dgp1130", "review-agent", 1, "sha1");
    const outcome = await evaluateSinglePr(
      new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "sha1" }))) as never,
      { owner: "dgp1130", repo: "review-agent", number: 1 },
      "dgp1130",
      state,
    );
    expect(outcome.shouldReview).toBe(false);
    expect(outcome.reviewedAtHead).toBe(true);
  });
});

describe("firstAddedLine", () => {
  it("returns the first added line of the first hunk", () => {
    const patch = "@@ -0,0 +1,4 @@\n+# Test PR content\n+\n+More\n+Last\n";
    expect(firstAddedLine(patch)).toBe(1);
  });

  it("skips context lines before returning an added line", () => {
    const patch = "@@ -5,3 +5,4 @@\n  a\n  b\n+c\n";
    expect(firstAddedLine(patch)).toBe(7);
  });

  it("returns null when there is no added line or hunk", () => {
    expect(firstAddedLine("no hunk here")).toBeNull();
    expect(firstAddedLine("@@ -1,2 +1,2 @@\n  a\n  b\n")).toBeNull();
  });
});

describe("buildFixtureComments", () => {
  function file(filename: string, patch: string | undefined, status: PrFile["status"] = "added"): PrFile {
    return { filename, status, additions: 0, deletions: 0, changes: 0, patch };
  }

  it("produces one comment per non-removed file with a patch", () => {
    const files: PrFile[] = [
      file("M1-test.txt", "@@ -0,0 +1,2 @@\n+hi\n+there", "added"),
      file("src/a.ts", "@@ -1,1 +1,2 @@\n x\n+y", "modified"),
      file("gone.txt", undefined, "removed"),
      file("empty.ts", undefined, "added"),
    ];
    const comments = buildFixtureComments(files);
    expect(comments).toHaveLength(2);
    expect(comments[0].path).toBe("M1-test.txt");
    expect(comments[1].path).toBe("src/a.ts");
  });
});

describe("reviewSinglePr", () => {
  class FakeClient {
    constructor(
      private readonly node: RawNode | null,
      private readonly files: unknown[] = [],
      private readonly reviews: Record<string, unknown> = {},
    ) {}

    async graphql(): Promise<{ repository: { pullRequest: RawNode | null } }> {
      return { repository: { pullRequest: this.node } };
    }

    async rest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
      if (method === "GET" && endpoint.includes("/files?per_page=100")) {
        return this.files as T;
      }
      if (method === "GET" && endpoint.includes("/reviews/")) {
        return [{ id: 55, path: "M1-test.txt", line: 1, body: "x", created_at: "t" }] as T;
      }
      if (method === "GET" && endpoint.includes("/pulls/")) {
        return [] as T;
      }
      if (method === "POST" && endpoint.endsWith("/reviews")) {
        const id = (body as { comments: unknown[] }).comments.length + 1000;
        return { id, state: "PENDING" } as T;
      }
      return this.files as T;
    }
  }

  it("posts a fixture draft review and records state for an eligible, unreviewed PR", async () => {
    const node = rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 }));
    const client = new FakeClient(node, [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ]);
    const state = emptyState();
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state);

    expect(outcome.shouldReview).toBe(true);
    expect(outcome.posted?.state).toBe("PENDING");
    expect(outcome.files).toHaveLength(1);

    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shax");
    expect(record.draftCommentIds.length).toBeGreaterThan(0);
    expect(record.messages).toHaveLength(1);
  });

  it("skips posting when already reviewed at head", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 9)] = makePrRecord("dgp1130", "review-agent", 9, "shax");
    const client = new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 })));
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state);
    expect(outcome.shouldReview).toBe(false);
    expect(outcome.posted).toBeUndefined();
  });
});
