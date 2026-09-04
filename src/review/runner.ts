import { GitHubClient } from "../github/client.js";
import { fetchPrByRef, PullRequestInfo } from "../github/prs.js";
import { getPr } from "../state/store.js";
import { State } from "../state/types.js";
import { PrRef, needsReview } from "./workflow.js";

/**
 * A PR must be open, not a fork, and involve the current user (as a requested
 * reviewer or assignee) to be considered for review.
 */
export function isEligible(info: PullRequestInfo): boolean {
  return info.state === "OPEN" && !info.isCrossRepository && (info.isReviewRequested || info.isAssignee);
}

export interface SinglePrOutcome {
  ref: PrRef;
  info: PullRequestInfo;
  reviewedAtHead: boolean;
  shouldReview: boolean;
  reason: string;
}

/**
 * Evaluates a single PR: fetches it, determines whether the current user is
 * eligible and whether it requires a (re-)review. This is the M1 stepping stone
 * shared by the --pr mode and the polling daemon.
 */
export async function evaluateSinglePr(
  client: GitHubClient,
  ref: PrRef,
  username: string,
  state: State,
): Promise<SinglePrOutcome> {
  const info = await fetchPrByRef(client, ref, username);
  if (!info) {
    return {
      ref,
      info: undefined as unknown as PullRequestInfo,
      reviewedAtHead: false,
      shouldReview: false,
      reason: `PR ${ref.owner}/${ref.repo}#${ref.number} was not found.`,
    };
  }

  if (!isEligible(info)) {
    return {
      ref,
      info,
      reviewedAtHead: false,
      shouldReview: false,
      reason: `PR is not eligible: state=${info.state}, fork=${info.isCrossRepository}, reviewRequested=${info.isReviewRequested}, assigned=${info.isAssignee}.`,
    };
  }

  const record = getPr(state, ref.owner, ref.repo, ref.number);
  const needs = needsReview(info.headRefOid, record);
  return {
    ref,
    info,
    reviewedAtHead: !needs,
    shouldReview: needs,
    reason: needs
      ? "PR requires a new review at the current head SHA."
      : "PR has already been reviewed at the current head SHA.",
  };
}
