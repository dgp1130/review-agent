import { GitHubClient } from "./client.js";

export interface DraftComment {
  path: string;
  /** Line number in the file (RIGHT side of the diff) to attach the comment. */
  line: number;
  /** Optional start line to create a multi-line comment range. */
  startLine?: number;
  body: string;
}

export interface ReviewCommentView {
  id: number;
  path: string;
  line: number | null;
  body: string;
  created_at: string;
}

interface CreateReviewResponse {
  id: number;
  state: string;
}

interface ReviewCommentsResponse {
  id: number;
  path: string;
  line: number | null;
  body: string;
  created_at: string;
}

interface ReviewListResponse {
  id: number;
  state: string;
  submitted_at?: string | null;
  user: { login: string } | null;
}

export interface PostedReview {
  reviewId: number;
  state: string;
  commentIds: number[];
}

/**
 * Posts a PENDING (draft) review with inline comments by omitting the `event`
 * field. A pending review is an editable draft visible only to the author in
 * the GitHub UI and is never submitted. This is the ONLY way this agent posts
 * comments; it never creates a submitted/non-draft review.
 *
 * The single create response does not include the comments, so we read them
 * back from the review's own comments endpoint to record their IDs.
 */
export async function postDraftReview(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number; commitSha: string; comments: DraftComment[]; allowedPaths: Set<string> },
): Promise<PostedReview> {
  if (opts.comments.length === 0) {
    throw new Error("Refusing to post an empty draft review with no comments.");
  }

  for (const comment of opts.comments) {
    if (!opts.allowedPaths.has(comment.path)) {
      throw new Error(
        `Refusing to comment on "${comment.path}": it is not a file changed by the PR.`,
      );
    }
  }

  const endpoint = `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/reviews`;
  // NOTE: no `event` field => the review is created in PENDING (draft) state.
  const body = {
    commit_id: opts.commitSha,
    comments: opts.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      ...(c.startLine !== undefined && c.startLine !== null ? { start_line: c.startLine } : {}),
      body: c.body,
    })),
  };

  const created = await client.rest<CreateReviewResponse>("POST", endpoint, body);
  if (created.state !== "PENDING") {
    throw new Error(
      `BUG: review was created in unexpected state ${created.state}; the agent must only create PENDING (draft) reviews.`,
    );
  }

  const comments = await client.rest<ReviewCommentsResponse[]>(
    "GET",
    `${endpoint}/${created.id}/comments`,
  );

  return {
    reviewId: created.id,
    state: created.state,
    commentIds: comments.map((c) => c.id),
  };
}

/** Fetches all review comments on a PR (both pending and submitted). */
export async function fetchReviewComments(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
): Promise<ReviewCommentView[]> {
  const comments = await client.rest<ReviewCommentsResponse[]>(
    "GET",
    `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/comments?per_page=100`,
  );
  return comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line,
    body: c.body,
    created_at: c.created_at,
  }));
}

/** Fetches the list of reviews (excluding pending/draft ones) for a PR. */
export async function fetchReviews(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
): Promise<ReviewListResponse[]> {
  return client.rest<ReviewListResponse[]>(
    "GET",
    `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/reviews?per_page=100`,
  );
}

/** A PENDING (draft) review together with the comments it holds. */
export interface PendingReviewWithComments {
  reviewId: number;
  comments: ReviewCommentsResponse[];
}

/**
 * Fetches every PENDING (draft) review on a PR along with its comments. Pending
 * comments are not exposed by `GET /pulls/{n}/comments`, so they must be read
 * from each review's own comments endpoint.
 */
export async function fetchPendingReviewsWithComments(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
): Promise<PendingReviewWithComments[]> {
  const reviews = await fetchReviews(client, opts);
  const pending: PendingReviewWithComments[] = [];
  for (const review of reviews) {
    if (review.state !== "PENDING") {
      continue;
    }
    const comments = await client.rest<ReviewCommentsResponse[]>(
      "GET",
      `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/reviews/${review.id}/comments`,
    );
    pending.push({ reviewId: review.id, comments });
  }
  return pending;
}

/**
 * Deletes a single review comment this agent previously posted on a PENDING
 * (draft) review. GitHub cannot update a pending review, so clearing our own
 * draft means deleting each of our comments individually rather than the whole
 * review — deleting the entire review would also remove any comment a human
 * added via the GitHub UI. The endpoint is the same one the GitHub UI uses.
 * Note the URL has no PR number: `pulls/comments/{id}`, not `pulls/{n}/comments/{id}`.
 */
export async function deleteDraftComment(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
  commentId: number,
): Promise<void> {
  await client.rest<{ id: number }>(
    "DELETE",
    `/repos/${opts.owner}/${opts.repo}/pulls/comments/${commentId}`,
  );
}

/**
 * Deletes a PENDING (draft) review. GitHub's REST API only permits deleting
 * reviews in the PENDING state (submitted reviews can never be deleted). This
 * is used to remove the now-empty review shell after this agent deletes its own
 * comments from a review it fully owned, so the one-pending-review-per-user
 * slot frees up for a fresh review. Deleting an empty review removes no comment
 * a human wrote.
 */
export async function deletePendingReview(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
  reviewId: number,
): Promise<void> {
  await client.rest<{ id: number }>(
    "DELETE",
    `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/reviews/${reviewId}`,
  );
}
