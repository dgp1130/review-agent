export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PrRecord {
  owner: string;
  repo: string;
  number: number;
  reviewedAt: string;
  /** Commit SHA at which the last review was produced. */
  lastReviewedCommitSha: string;
  /** Conversation history for this PR, reused across re-reviews. */
  messages: ChatMessage[];
  /** IDs of draft comments posted for this PR. */
  draftCommentIds: string[];
  /** ID of the PENDING (draft) review this agent last posted for this PR. */
  draftReviewId?: string;
  /**
   * Set when this PR dropped out of the candidate list (the user is no longer a
   * requested reviewer/assignee) and a state check confirmed it is still open.
   * Once set, the daemon stops querying the PR: the record is retained so a
   * dropped review can still be answered, and restored PRs must be re-probed to
   * reap the ones that later close (see `pruneClosedPrs`).
   */
  lastProbeAt?: string;
}

export interface State {
  prs: Record<string, PrRecord>;
}

export function emptyState(): State {
  return { prs: {} };
}

export function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function makePrRecord(owner: string, repo: string, number: number, headSha: string): PrRecord {
  return {
    owner,
    repo,
    number,
    reviewedAt: new Date().toISOString(),
    lastReviewedCommitSha: headSha,
    messages: [],
    draftCommentIds: [],
  };
}
