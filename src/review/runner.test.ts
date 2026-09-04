import { describe, expect, it } from "vitest";
import { isEligible, evaluateSinglePr } from "./runner.js";
import { PullRequestInfo } from "../github/prs.js";
import { emptyState, makePrRecord, prKey } from "../state/types.js";

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

  it("is false for closed or fork PRs", () => {
    expect(isEligible(info({ state: "CLOSED", isReviewRequested: true }))).toBe(false);
    expect(isEligible(info({ isCrossRepository: true, isReviewRequested: true }))).toBe(false);
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
