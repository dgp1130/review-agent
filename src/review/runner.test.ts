import { describe, expect, it } from "vitest";
import { isEligible, evaluateSinglePr, reviewSinglePr, firstAddedLine } from "./runner.js";
import { PullRequestInfo } from "../github/prs.js";
import { emptyState, makePrRecord, prKey } from "../state/types.js";
import { Config } from "../config.js";
import { ChatProvider } from "../llm/types.js";

function info(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    owner: "dgp1130",
    repo: "review-agent",
    number: 1,
    title: "t",
    state: "OPEN",
    isCrossRepository: false,
    headRefOid: "sha1",
    headOwner: "dgp1130",
    headRepo: "review-agent",
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
  headRepository: { name: string; owner: { login: string } };
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
    headOwner: p.headOwner,
    headRepo: p.headRepo,
    reviewRequests: {
      nodes: p.isReviewRequested ? [{ requestedReviewer: { login: "dgp1130" } }] : [],
    },
    assignees: { nodes: p.isAssignee ? [{ login: "dgp1130" }] : [] },
    repository: { name: p.repo, owner: { login: p.owner } },
    headRepository: { name: p.headRepo, owner: { login: p.headOwner } },
  };
}

function makeConfig(): Config {
  return {
    skillPath: "SKILL.md",
    repo: "dgp1130/review-agent",
    orgs: [],
    statePath: "/tmp/state-test.json",
  };
}

/** A provider that emits a single assistant turn with zero tool calls. */
function textProvider(summary = "Looks good."): ChatProvider {
  return {
    complete: async () => ({ content: summary, toolCalls: [] }),
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

  it("posts a draft review from queued comments after the LLM runs", async () => {
    const node = rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 }));
    const client = new FakeClient(node, [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ]);
    const state = emptyState();

    let calls = 0;
    const provider: ChatProvider = {
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "c1", name: "create_comment", arguments: { path: "M1-test.txt", line: 1, body: "Missing heading." } },
            ],
          };
        }
        return { content: "Found 1 issue.", toolCalls: [] };
      },
    };

    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: provider as never,
    });

    expect(outcome.shouldReview).toBe(true);
    expect(outcome.posted?.state).toBe("PENDING");
    expect(outcome.posted?.commentIds).toHaveLength(1);
    expect(outcome.files).toHaveLength(1);
    expect(outcome.turns).toBe(1);

    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shax");
    expect(record.draftCommentIds.length).toBeGreaterThan(0);
    expect(record.messages).toHaveLength(1);
    expect(record.messages[0].content).toBe("Found 1 issue.");
  });

  it("produces no review when the agent queues no comments", async () => {
    const node = rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 }));
    const client = new FakeClient(node, [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ]);
    const state = emptyState();
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: textProvider("No findings.") as never,
    });

    expect(outcome.shouldReview).toBe(true);
    expect(outcome.posted).toBeUndefined();
    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shax");
    expect(record.messages[0].content).toBe("No findings.");
    // The head is still recorded (and reported) as reviewed so this is not
    // re-attempted every tick, matching the blocked path.
    expect(outcome.reviewedAtHead).toBe(true);
  });

  it("skips posting when already reviewed at head", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 9)] = makePrRecord("dgp1130", "review-agent", 9, "shax");
    const client = new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 })));
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
    });
    expect(outcome.shouldReview).toBe(false);
    expect(outcome.posted).toBeUndefined();
  });

  it("seeds prior conversation into a re-review at a new head SHA", async () => {
    // Round 1 reviews the PR at head "shax".
    const round1Client = new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 })), [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,4 @@\n+# Test\n+\n+more\n+even more" },
    ]);
    const round1State = emptyState();
    await reviewSinglePr(
      round1Client as never,
      { owner: "dgp1130", repo: "review-agent", number: 9 },
      "dgp1130",
      round1State,
      {
        skillContent: "# Review skill",
        config: makeConfig(),
        allowListedOwners: [],
        provider: textProvider("Round one summary.") as never,
      },
    );
    expect(round1State.prs[prKey("dgp1130", "review-agent", 9)].lastReviewedCommitSha).toBe("shax");

    // Round 2: the head moved to "shay"; capture what the provider sees.
    const round2Client = new FakeClient(rawNode(info({ isReviewRequested: true, headRefOid: "shay", number: 9 })), [
      { filename: "M1-test.txt", status: "added", additions: 4, deletions: 0, changes: 4, patch: "@@ -0,0 +1,4 @@\n+# Test\n+\n+more\n+even more" },
    ]);
    let seenFirstCallMessages: unknown[] = [];
    let calls = 0;
    const capturingProvider: ChatProvider = {
      complete: async (req) => {
        calls += 1;
        if (calls === 1) {
          seenFirstCallMessages = req.messages.map((m) => ({ role: m.role, content: m.content }));
        }
        return { content: "Round two summary.", toolCalls: [] };
      },
    };

    const outcome = await reviewSinglePr(
      round2Client as never,
      { owner: "dgp1130", repo: "review-agent", number: 9 },
      "dgp1130",
      round1State,
      {
        skillContent: "# Review skill",
        config: makeConfig(),
        allowListedOwners: [],
        provider: capturingProvider as never,
      },
    );

    expect(outcome.shouldReview).toBe(true);
    // The prior stored summary is the first message, followed by the new user prompt.
    expect(seenFirstCallMessages[0]).toMatchObject({ role: "assistant", content: "Round one summary." });
    const userPrompt = seenFirstCallMessages[1] as { content: string };
    expect(userPrompt.content).toContain("Re-review notice");
    expect(userPrompt.content).toContain("shax");
    expect(userPrompt.content).toContain("shay");
    const record = round1State.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shay");
    // Round 1 summary + round 2 summary are both preserved.
    expect(record.messages.map((m) => m.content)).toEqual(["Round one summary.", "Round two summary."]);
  });

  it("bounds the stored conversation to the most recent rounds", async () => {
    const node = rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 }));
    const client = new FakeClient(node, [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ]);
    const state = emptyState();
    const record = makePrRecord("dgp1130", "review-agent", 9, "shaold");
    record.messages = Array.from({ length: 11 }, (_, i) => ({ role: "assistant" as const, content: `Old round ${i}.` }));
    state.prs[prKey("dgp1130", "review-agent", 9)] = record;

    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: textProvider("Newest round.") as never,
    });

    expect(outcome.shouldReview).toBe(true);
    const stored = state.prs[prKey("dgp1130", "review-agent", 9)].messages;
    // 12 stored rounds are trimmed to the cap of 10; the oldest are dropped and
    // the newest round is retained.
    expect(stored).toHaveLength(10);
    expect(stored[0].content).toBe("Old round 2.");
    expect(stored[stored.length - 1].content).toBe("Newest round.");
  });

  it("skips posting when the head SHA advances during the review", async () => {
    // The by-ref query is served twice per review: once at the start (head
    // "shax") and once just before posting (head "shay"). The mismatch must
    // prevent posting stale comments without advancing the record.
    let byRefCalls = 0;
    const files: unknown[] = [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ];
    const client = {
      graphql: async () => {
        byRefCalls += 1;
        return {
          repository: {
            pullRequest: rawNode(info({ isReviewRequested: true, headRefOid: byRefCalls === 1 ? "shax" : "shay", number: 9 })),
          },
        };
      },
      rest: async (method: string, endpoint: string, body?: unknown) => {
        if (method === "GET" && endpoint.includes("/files?per_page=100")) {
          return files;
        }
        if (method === "GET" && endpoint.includes("/pulls/")) {
          return [];
        }
        if (method === "POST" && endpoint.endsWith("/reviews")) {
          return { id: 1000, state: "PENDING" };
        }
        return [];
      },
    };
    const state = emptyState();
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: {
        complete: async () => ({
          content: "",
          toolCalls: [
            { id: "c1", name: "create_comment", arguments: { path: "M1-test.txt", line: 1, body: "Missing heading." } },
          ],
        }),
      } as never,
    });

    expect(outcome.shouldReview).toBe(false);
    expect(outcome.posted).toBeUndefined();
    expect(outcome.reason).toContain("head changed during review");
    // The record must NOT be advanced to "shax" (a real re-review may still happen).
    expect(state.prs[prKey("dgp1130", "review-agent", 9)]).toBeUndefined();
  });

  it("skips posting when a pending review contains comments the agent does not own, and leaves them alone", async () => {
    // Simulates the user having added a manual draft comment (id 999) via the
    // GitHub UI. The agent must NOT delete it and must NOT post its own review,
    // since GitHub allows only one pending review per user.
    const files: unknown[] = [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ];
    const calls: { method: string; endpoint: string; body?: unknown }[] = [];
    const client = {
      graphql: async () => ({
        repository: {
          pullRequest: rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 })),
        },
      }),
      rest: async (method: string, endpoint: string, body?: unknown) => {
        calls.push({ method, endpoint, body });
        if (method === "GET" && endpoint.includes("/files?per_page=100")) {
          return files;
        }
        if (method === "GET" && endpoint.includes("/comments?per_page=100")) {
          return [];
        }
        if (method === "GET" && endpoint.includes("/reviews?per_page=100")) {
          return [{ id: 7, state: "PENDING" }];
        }
        if (method === "GET" && endpoint.includes("/reviews/7/comments")) {
          return [{ id: 999, path: "M1-test.txt", line: 1, body: "Manual UI comment.", created_at: "t" }];
        }
        if (method === "GET" && endpoint.includes("/pulls/")) {
          return [];
        }
        return [];
      },
    };
    const state = emptyState();
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: {
        complete: async () => ({
          content: "",
          toolCalls: [
            { id: "c1", name: "create_comment", arguments: { path: "M1-test.txt", line: 1, body: "Missing heading." } },
          ],
        }),
      } as never,
    });

    // Nothing was deleted or posted.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(outcome.posted).toBeUndefined();
    expect(outcome.reason).toMatch(/not created by this agent/);
    // The head is still recorded so this is not re-attempted every tick.
    expect(outcome.reviewedAtHead).toBe(true);
    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shax");
    expect(record.draftCommentIds).toEqual([]);
  });

  it("deletes only its own prior draft comments before posting a fresh review", async () => {
    const files: unknown[] = [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ];
    const calls: { method: string; endpoint: string; body?: unknown }[] = [];
    const client = {
      graphql: async () => ({
        repository: {
          pullRequest: rawNode(info({ isReviewRequested: true, headRefOid: "shaz", number: 9 })),
        },
      }),
      rest: async (method: string, endpoint: string, body?: unknown) => {
        calls.push({ method, endpoint, body });
        if (method === "GET" && endpoint.includes("/files?per_page=100")) {
          return files;
        }
        if (method === "GET" && endpoint.includes("/comments?per_page=100")) {
          return [];
        }
        if (method === "GET" && endpoint.includes("/reviews?per_page=100")) {
          // Only the agent's own pending review exists (its only comment is id 101).
          return [{ id: 7, state: "PENDING" }];
        }
        if (method === "GET" && endpoint.includes("/reviews/7/comments")) {
          return [{ id: 101, path: "M1-test.txt", line: 2, body: "Old agent comment.", created_at: "t" }];
        }
        if (method === "GET" && endpoint.includes("/pulls/")) {
          return [];
        }
        if (method === "POST" && endpoint.endsWith("/reviews")) {
          return { id: 2000, state: "PENDING" };
        }
        return [];
      },
    };
    const state = emptyState();
    // Round 1 reviewed head "shax" and recorded this agent's own comment id.
    const record = makePrRecord("dgp1130", "review-agent", 9, "shax");
    record.draftCommentIds = ["101"];
    record.draftReviewId = "7";
    state.prs[prKey("dgp1130", "review-agent", 9)] = record;

    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: {
        complete: async () => ({
          content: "",
          toolCalls: [
            { id: "c1", name: "create_comment", arguments: { path: "M1-test.txt", line: 2, body: "Fresh agent comment." } },
          ],
        }),
      } as never,
    });

    // The agent's own pending review was deleted wholesale, then a fresh one posted.
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.endpoint)).toEqual([
      "/repos/dgp1130/review-agent/pulls/9/reviews/7",
    ]);
    expect(outcome.posted).toBeDefined();
    expect(outcome.reviewedAtHead).toBe(false);
    const newRecord = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(newRecord.lastReviewedCommitSha).toBe("shaz");
    expect(newRecord.draftReviewId).toBe("2000");
  });

  it("does not repost a comment that already exists on the PR", async () => {
    const files: unknown[] = [
      { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
    ];
    // The PR already carries a pending review comment on M1-test.txt:1.
    const client = {
      graphql: async () => ({
        repository: {
          pullRequest: rawNode(info({ isReviewRequested: true, headRefOid: "shax", number: 9 })),
        },
      }),
      rest: async (method: string, endpoint: string, body?: unknown) => {
        if (method === "GET" && endpoint.includes("/comments?per_page=100")) {
          return [{ id: 1, path: "M1-test.txt", line: 1, body: "Missing heading.", created_at: "t" }];
        }
        if (method === "GET" && endpoint.includes("/files?per_page=100")) {
          return files;
        }
        if (method === "GET" && endpoint.includes("/pulls/")) {
          return [];
        }
        if (method === "POST" && endpoint.endsWith("/reviews")) {
          const id = (body as { comments: unknown[] }).comments.length + 1000;
          return { id, state: "PENDING" };
        }
        return [];
      },
    };
    const state = emptyState();
    const outcome = await reviewSinglePr(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, "dgp1130", state, {
      skillContent: "# Review skill",
      config: makeConfig(),
      allowListedOwners: [],
      provider: {
        complete: async () => ({
          content: "",
          toolCalls: [
            { id: "c1", name: "create_comment", arguments: { path: "M1-test.txt", line: 1, body: "Missing heading." } },
          ],
        }),
      } as never,
    });

    // The comment was deduped, so nothing new was posted, but the review is
    // still recorded at head so it is not redone every tick.
    expect(outcome.posted).toBeUndefined();
    expect(outcome.shouldReview).toBe(true);
    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("shax");
    expect(record.draftCommentIds).toEqual([]);
  });
});
