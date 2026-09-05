import { describe, expect, it } from "vitest";
import {
  postDraftReview,
  fetchReviewComments,
  fetchPendingReviewsWithComments,
  deleteDraftComment,
  deletePendingReview,
  DraftComment,
} from "./comments.js";

type Endpoint = `${"GET" | "POST" | "DELETE"} ${string}`;

class FakeClient {
  private readonly captured: { method: string; endpoint: string; body?: unknown }[] = [];
  constructor(private readonly responses: Partial<Record<Endpoint, unknown>> = {}) {}

  async rest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    this.captured.push({ method, endpoint, body });
    const key = `${method} ${endpoint}` as Endpoint;
    const response = this.responses[key];
    if (response === undefined) {
      throw new Error(`Unexpected call: ${key}`);
    }
    return response as T;
  }

  calls(): { method: string; endpoint: string; body?: unknown }[] {
    return this.captured;
  }
}

const opts = {
  owner: "dgp1130",
  repo: "review-agent",
  number: 9,
  commitSha: "abc123",
};

const allowedPaths = new Set(["M1-test.txt", "src/a.ts"]);

describe("postDraftReview", () => {
  it("creates a PENDING (draft) review: no event field and correct comment payload", async () => {
    const client = new FakeClient({
      "POST /repos/dgp1130/review-agent/pulls/9/reviews": { id: 55, state: "PENDING" },
      "GET /repos/dgp1130/review-agent/pulls/9/reviews/55/comments": [
        { id: 101, path: "M1-test.txt", line: 1, body: "hi", created_at: "t" },
      ],
    });
    const comments: DraftComment[] = [{ path: "M1-test.txt", line: 1, body: "hi" }];
    const result = await postDraftReview(client as never, { ...opts, comments, allowedPaths });

    expect(result).toEqual({ reviewId: 55, state: "PENDING", commentIds: [101] });

    const post = client.calls().find((c) => c.method === "POST");
    const body = post?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("event");
    expect(body).toMatchObject({
      commit_id: "abc123",
      comments: [{ path: "M1-test.txt", line: 1, side: "RIGHT", body: "hi" }],
    });
  });

  it("throws when the review is not PENDING", async () => {
    const client = new FakeClient({
      "POST /repos/dgp1130/review-agent/pulls/9/reviews": { id: 55, state: "APPROVED" },
    });
    await expect(
      postDraftReview(client as never, { ...opts, comments: [{ path: "M1-test.txt", line: 1, body: "x" }], allowedPaths }),
    ).rejects.toThrow(/PENDING/);
  });

  it("throws for an empty comment list", async () => {
    const client = new FakeClient();
    await expect(postDraftReview(client as never, { ...opts, comments: [], allowedPaths })).rejects.toThrow(/empty/);
  });

  it("rejects comments on files not changed by the PR", async () => {
    const client = new FakeClient();
    await expect(
      postDraftReview(client as never, {
        ...opts,
        comments: [{ path: "outside.txt", line: 1, body: "x" }],
        allowedPaths,
      }),
    ).rejects.toThrow(/not a file changed/);
  });

  it("omits start_line when not provided", async () => {
    const client = new FakeClient({
      "POST /repos/dgp1130/review-agent/pulls/9/reviews": { id: 55, state: "PENDING" },
      "GET /repos/dgp1130/review-agent/pulls/9/reviews/55/comments": [],
    });
    await postDraftReview(client as never, {
      ...opts,
      comments: [{ path: "M1-test.txt", line: 3, body: "x" }],
      allowedPaths,
    });
    const post = client.calls().find((c) => c.method === "POST");
    const body = post?.body as { comments: Record<string, unknown>[] };
    expect(body.comments[0]).not.toHaveProperty("start_line");
  });
});

describe("fetchReviewComments", () => {
  it("maps REST comments into a view model", async () => {
    const client = new FakeClient({
      "GET /repos/dgp1130/review-agent/pulls/9/comments?per_page=100": [
        { id: 1, path: "a", line: 2, body: "hello", created_at: "t1" },
      ],
    });
    const comments = await fetchReviewComments(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 });
    expect(comments).toEqual([{ id: 1, path: "a", line: 2, body: "hello", created_at: "t1" }]);
  });
});

describe("fetchPendingReviewsWithComments", () => {
  it("returns PENDING reviews with their comments, skipping submitted ones", async () => {
    const client = new FakeClient({
      "GET /repos/dgp1130/review-agent/pulls/9/reviews?per_page=100": [
        { id: 1, state: "PENDING" },
        { id: 2, state: "APPROVED" },
        { id: 3, state: "PENDING" },
      ],
      "GET /repos/dgp1130/review-agent/pulls/9/reviews/1/comments": [
        { id: 11, path: "a", line: 1, body: "x", created_at: "t" },
        { id: 12, path: "b", line: 2, body: "y", created_at: "t" },
      ],
      "GET /repos/dgp1130/review-agent/pulls/9/reviews/3/comments": [{ id: 31, path: "c", line: 3, body: "z", created_at: "t" }],
    });
    const pending = await fetchPendingReviewsWithComments(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 });
    expect(pending).toEqual([
      { reviewId: 1, comments: [{ id: 11, path: "a", line: 1, body: "x", created_at: "t" }, { id: 12, path: "b", line: 2, body: "y", created_at: "t" }] },
      { reviewId: 3, comments: [{ id: 31, path: "c", line: 3, body: "z", created_at: "t" }] },
    ]);
  });

  it("returns an empty list when there are no pending reviews", async () => {
    const client = new FakeClient({
      "GET /repos/dgp1130/review-agent/pulls/9/reviews?per_page=100": [
        { id: 1, state: "APPROVED" },
      ],
    });
    const pending = await fetchPendingReviewsWithComments(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 });
    expect(pending).toEqual([]);
  });
});

describe("deleteDraftComment", () => {
  it("deletes a single review comment by comment ID", async () => {
    const client = new FakeClient({
      "DELETE /repos/dgp1130/review-agent/pulls/comments/101": { id: 101 },
    });
    await deleteDraftComment(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, 101);
    const calls = client.calls().filter((c) => c.method === "DELETE");
    expect(calls.map((c) => c.endpoint)).toEqual(["/repos/dgp1130/review-agent/pulls/comments/101"]);
  });
});

describe("deletePendingReview", () => {
  it("deletes a PENDING review directly by review ID", async () => {
    const client = new FakeClient({
      "DELETE /repos/dgp1130/review-agent/pulls/9/reviews/55": { id: 55, state: "PENDING" },
    });
    await deletePendingReview(client as never, { owner: "dgp1130", repo: "review-agent", number: 9 }, 55);
    const calls = client.calls().filter((c) => c.method === "DELETE");
    expect(calls.map((c) => c.endpoint)).toEqual(["/repos/dgp1130/review-agent/pulls/9/reviews/55"]);
  });
});
