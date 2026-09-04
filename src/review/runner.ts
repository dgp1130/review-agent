import { GitHubClient } from "../github/client.js";
import { fetchPrByRef, PullRequestInfo } from "../github/prs.js";
import { postDraftReview, DraftComment, PostedReview } from "../github/comments.js";
import { fetchPrFiles, firstAddedLine, PrFile } from "../github/diffs.js";

export { firstAddedLine } from "../github/diffs.js";
import { getPr, putPr } from "../state/store.js";
import { makePrRecord, State } from "../state/types.js";
import { PrRef, needsReview } from "./workflow.js";

/**
 * A PR is eligible for review when it is open and involves the current user (as
 * a requested reviewer or assignee). Fork (cross-repository) PRs are eligible
 * too: comments are only ever posted to the base repo's PR review endpoint, and
 * discovery/the --pr path are gated by the repo allowlist.
 */
export function isEligible(info: PullRequestInfo): boolean {
  return info.state === "OPEN" && (info.isReviewRequested || info.isAssignee);
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
      reason: `PR is not eligible: state=${info.state}, reviewRequested=${info.isReviewRequested}, assigned=${info.isAssignee}.`,
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

export interface ReviewPrOutcome extends SinglePrOutcome {
  files: PrFile[];
  posted?: PostedReview;
}

/**
 * Fully reviews a single PR through the `--pr` path.
 *
 * This is the M2 fixture-injection: the comments posted are a small, fixed set
 * derived from a fixture rather than from an LLM. In Milestone 4 the fixture is
 * replaced by the real LLM-driven comment generation; the posting mechanics,
 * path validation and state recording stay as-is.
 */
export async function reviewSinglePr(
  client: GitHubClient,
  ref: PrRef,
  username: string,
  state: State,
): Promise<ReviewPrOutcome> {
  const info = await fetchPrByRef(client, ref, username);
  if (!info) {
    return {
      ref,
      info: undefined as unknown as PullRequestInfo,
      reviewedAtHead: false,
      shouldReview: false,
      reason: `PR ${ref.owner}/${ref.repo}#${ref.number} was not found.`,
      files: [],
    };
  }

  if (!isEligible(info)) {
    return {
      ref,
      info,
      reviewedAtHead: false,
      shouldReview: false,
      reason: `PR is not eligible: state=${info.state}, reviewRequested=${info.isReviewRequested}, assigned=${info.isAssignee}.`,
      files: [],
    };
  }

  const record = getPr(state, ref.owner, ref.repo, ref.number);
  if (!needsReview(info.headRefOid, record)) {
    return {
      ref,
      info,
      reviewedAtHead: true,
      shouldReview: false,
      reason: "PR has already been reviewed at the current head SHA.",
      files: [],
    };
  }

  const files = await fetchPrFiles(client, { owner: ref.owner, repo: ref.repo, number: ref.number });
  const allowedPaths = new Set(files.map((f) => f.filename));
  const comments = buildFixtureComments(files);

  let posted: PostedReview | undefined;
  if (comments.length > 0) {
    posted = await postDraftReview(client, {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      commitSha: info.headRefOid,
      allowedPaths,
      comments,
    });
  }

  const newRecord = makePrRecord(ref.owner, ref.repo, ref.number, info.headRefOid);
  newRecord.draftCommentIds = (posted?.commentIds ?? []).map(String);
  newRecord.messages = record?.messages ?? [];
  newRecord.messages.push({
    role: "assistant",
    content: `Posted ${comments.length} draft comment(s) at head ${info.headRefOid}.`,
  });
  const nextState = putPr(state, newRecord);
  Object.assign(state, nextState);

  return {
    ref,
    info,
    reviewedAtHead: false,
    shouldReview: true,
    reason: posted
      ? `Posted ${comments.length} draft comment(s) as a pending review at head ${info.headRefOid}.`
      : "PR needs review but produced no comments to post.",
    files,
    posted,
  };
}

/**
 * M2 fixture: produces a small fixed set of draft comments (one per changed,
 * non-removed file, targeting the first added line of the first hunk). This is
 * temporary and replaced by real LLM output in Milestone 4.
 */
export function buildFixtureComments(files: PrFile[]): DraftComment[] {
  const comments: DraftComment[] = [];
  for (const file of files) {
    if (file.status === "removed" || !file.patch) {
      continue;
    }
    const line = firstAddedLine(file.patch);
    if (line === null) {
      continue;
    }
    comments.push({
      path: file.filename,
      line,
      body: `FIXTURE REVIEW: This draft comment was posted by the review agent during M2 validation. It will be replaced by real model-generated review comments.`,
    });
  }
  return comments;
}
