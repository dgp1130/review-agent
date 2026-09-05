import { GitHubClient } from "../github/client.js";
import { fetchPrByRef, PullRequestInfo } from "../github/prs.js";
import {
  postDraftReview,
  DraftComment,
  PostedReview,
  ReviewCommentView,
  fetchReviewComments,
  fetchPendingReviewsWithComments,
  deletePendingReview,
} from "../github/comments.js";
import { fetchPrFiles, fetchFileContent, addedLineNumbers, firstAddedLine, PrFile } from "../github/diffs.js";

export { firstAddedLine } from "../github/diffs.js";
import { getPr, putPr } from "../state/store.js";
import { makePrRecord, State } from "../state/types.js";
import { PrRef, needsReview } from "./workflow.js";
import { readFileSync } from "node:fs";
import { buildSystemPrompt, buildUserPrompt } from "../llm/prompt.js";
import { OpenAiCompatibleProvider, resolveProviderConfig } from "../llm/provider.js";
import { createToolExecutor, QueuedComment } from "../llm/tools.js";
import { runAgent } from "../llm/agent.js";
import { ChatMessage, ChatProvider } from "../llm/types.js";
import { Config } from "../config.js";

/**
 * Cap on the number of past review-round summaries kept per PR. Older rounds
 * are dropped so conversation size stays bounded across re-reviews (plan M5
 * step 3); the most recent rounds are always retained, so re-reviews still
 * build on what was already said.
 */
const MAX_RECORDED_MESSAGES = 10;

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
  turns?: number;
}

export interface ReviewSinglePrOptions {
  skillContent: string;
  config: Config;
  /** Allowlisted org owners for out-of-PR reads (defaults to the config orgs). */
  allowListedOwners: string[];
  /** Injectable provider for tests; otherwise resolved from env. */
  provider?: ChatProvider;
}

/**
 * Fully reviews a single PR through the `--pr` path.
 *
 * The LLM reviews the PR diff (reading files via constrained tools) and queues
 * draft comments that are collected into a single pending review and posted via
 * `postDraftReview`. The record's commit SHA is advanced so an unchanged PR is
 * not re-reviewed.
 */
export async function reviewSinglePr(
  client: GitHubClient,
  ref: PrRef,
  username: string,
  state: State,
  opts: ReviewSinglePrOptions,
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
  const changedPaths = new Set(files.map((f) => f.filename));
  const addedLines = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) {
      addedLines.set(file.filename, addedLineNumbers(file.patch));
    }
  }

  const existingComments = await fetchReviewComments(client, {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
  });

  const systemPrompt = buildSystemPrompt(opts.skillContent);
  const userPrompt = buildUserPrompt({
    pr: {
      owner: info.owner,
      repo: info.repo,
      number: info.number,
      title: info.title,
      author: username,
      headSha: info.headRefOid,
      body: null,
    },
    files,
    existingComments,
    lastReviewedCommitSha: record?.lastReviewedCommitSha,
  });

  const queue: QueuedComment[] = [];
  const provider = opts.provider ?? new OpenAiCompatibleProvider(resolveProviderConfig());
  const executor = createToolExecutor(
    client,
    {
      pr: {
        owner: info.owner,
        repo: info.repo,
        number: info.number,
        headSha: info.headRefOid,
        headOwner: info.headOwner,
        headRepo: info.headRepo,
      },
      isOwnerAllowed: (owner) => opts.allowListedOwners.includes(owner) || owner === defaultOwner(opts.config),
      changedPaths,
      addedLines,
    },
    queue,
  );

  const result = await runAgent(provider, executor, systemPrompt, userPrompt, {
    comments: queue,
    initialMessages: record?.messages?.map(toLlMessage) ?? [],
  });

  const comments: DraftComment[] = queue.map((c) => ({ path: c.path, line: c.line, body: c.body }));
  const deduped = dedupeComments(comments, existingComments);

  let posted: PostedReview | undefined;
  let blockedReason: string | undefined;
  if (deduped.length > 0) {
    // Re-check the head SHA immediately before posting: if the PR advanced
    // while the review was running, post nothing and let the next pass review
    // the new head (never attach stale comments to a newer commit).
    const latest = await fetchPrByRef(client, ref, username);
    if (!latest || latest.headRefOid !== info.headRefOid) {
      return {
        ref,
        info,
        reviewedAtHead: false,
        shouldReview: false,
        reason: "PR head changed during review; skipping to avoid posting stale comments.",
        files,
      };
    }

    // Clear any pending draft review this agent itself created in an earlier
    // round, so a re-review posts a fresh review without duplicating comments.
    // Comments or reviews a human adds manually (e.g. via the GitHub UI) are
    // NEVER deleted: if any pending draft contains a comment we did not create,
    // or is an unattributed empty draft, we refuse to post rather than risk
    // clobbering that work (GitHub allows only one pending review per user).
    const ownedIds = new Set(record?.draftCommentIds ?? []);
    const pendingReviews = await fetchPendingReviewsWithComments(client, {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
    });
    for (const pending of pendingReviews) {
      if (pending.comments.length === 0) {
        blockedReason =
          "An empty pending draft review exists on the PR. Not posting, to avoid clobbering " +
          "a draft we do not own (discard it in the GitHub UI first).";
        break;
      }
      const fullyOurs =
        ownedIds.size > 0 && pending.comments.every((c) => ownedIds.has(String(c.id)));
      if (fullyOurs) {
        await deletePendingReview(
          client,
          { owner: ref.owner, repo: ref.repo, number: ref.number },
          pending.reviewId,
        );
      } else {
        blockedReason =
          "A pending draft review still contains comments not created by this agent " +
          "(likely added via the GitHub UI). Not posting, to avoid deleting or overwriting them.";
        break;
      }
    }

    if (blockedReason === undefined) {
      posted = await postDraftReview(client, {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        commitSha: info.headRefOid,
        allowedPaths: changedPaths,
        comments: deduped,
      });
    }
  }

  const newRecord = makePrRecord(ref.owner, ref.repo, ref.number, info.headRefOid);
  newRecord.draftCommentIds = (posted?.commentIds ?? []).map(String);
  if (posted) {
    newRecord.draftReviewId = String(posted.reviewId);
  }
  newRecord.messages = record?.messages ?? [];
  newRecord.messages.push({
    role: "assistant",
    content: result.summary ?? `Reviewed head ${info.headRefOid} (${deduped.length} comment(s)).`,
  });
  if (newRecord.messages.length > MAX_RECORDED_MESSAGES) {
    newRecord.messages = newRecord.messages.slice(newRecord.messages.length - MAX_RECORDED_MESSAGES);
  }
  const nextState = putPr(state, newRecord);
  Object.assign(state, nextState);

  return {
    ref,
    info,
    reviewedAtHead: blockedReason !== undefined || deduped.length === 0,
    shouldReview: true,
    reason: posted
      ? `Posted ${deduped.length} draft comment(s) as a pending review at head ${info.headRefOid}.`
      : blockedReason ?? "PR needs review but produced no new comments to post.",
    files,
    posted,
    turns: result.turns,
  };
}

/**
 * Drops queued comments that duplicate an existing review comment on the PR (by
 * path, line, and normalized body) or another comment in the same batch, so a
 * re-review never reposts what has already been said.
 */
function dedupeComments(
  comments: DraftComment[],
  existing: ReviewCommentView[],
): DraftComment[] {
  const existingKeys = new Set(
    existing.flatMap((c) => (c.line !== null ? [commentKey(c.path, c.line, c.body)] : [])),
  );
  const seen = new Set<string>();
  const result: DraftComment[] = [];
  for (const comment of comments) {
    const key = commentKey(comment.path, comment.line, comment.body);
    if (existingKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(comment);
  }
  return result;
}

function commentKey(path: string, line: number, body: string): string {
  return `${path}:${line}:${body.trim()}`;
}

function defaultOwner(config: Config): string {
  return config.repo.split("/")[0];
}

/** Maps a stored state message into the LLM message shape. Only text turns are
 * kept; system/tool messages are not persisted (the system prompt is rebuilt
 * fresh each round). */
function toLlMessage(m: { role: "system" | "user" | "assistant"; content: string }): ChatMessage {
  return { role: m.role === "system" ? "user" : m.role, content: m.content };
}
