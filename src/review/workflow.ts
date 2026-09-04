import { prKey } from "../state/types.js";
import { PrRecord } from "../state/types.js";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parses a GitHub PR URL of the form
 * https://github.com/OWNER/REPO/pull/N  into an owner/repo/number ref.
 * Returns undefined if the URL is not a valid GitHub PR URL.
 */
export function parsePrUrl(url: string): PrRef | undefined {
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * Decides whether a PR needs a review, based on the previously recorded head
 * SHA. A PR needs a review when it has not been reviewed yet, or when its head
 * SHA has changed since the last review (which covers both new requests and
 * re-reviews after new commits).
 */
export function needsReview(
  headRefOid: string,
  record: PrRecord | undefined,
): boolean {
  if (record === undefined) {
    return true;
  }
  return record.lastReviewedCommitSha !== headRefOid;
}

export function recordKey(owner: string, repo: string, number: number): string {
  return prKey(owner, repo, number);
}
