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
