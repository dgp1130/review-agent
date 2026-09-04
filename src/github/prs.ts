import { GitHubClient } from "./client.js";
import { PrRef } from "../review/workflow.js";

export interface PullRequestInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isCrossRepository: boolean;
  headRefOid: string;
  /** True if the current user is in the requested-reviewers list. */
  isReviewRequested: boolean;
  /** True if the current user is an assignee. */
  isAssignee: boolean;
}

interface PrSearchItem {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isCrossRepository: boolean;
  headRefOid: string;
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  assignees: { nodes: { login?: string }[] };
  repository: { name: string; owner: { login: string } };
}

interface PrSearchResponse {
  search: { nodes: PrSearchItem[] };
}

interface PrByRefResponse {
  repository: { pullRequest: PrSearchItem | null };
}

const PR_FRAGMENT = `
fragment PrFragment on PullRequest {
  number
  title
  state
  isCrossRepository
  headRefOid
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on User { login } } }
  }
  assignees(first: 20) {
    nodes { login }
  }
  repository {
    name
    owner { login }
  }
}`;

const DISCOVERY_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        ...PrFragment
      }
    }
  }
}
${PR_FRAGMENT}`;

const PR_BY_REF_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ...PrFragment
    }
  }
}
${PR_FRAGMENT}`;

function requiresReviewer(candidate: PrSearchItem, username: string): boolean {
  return candidate.reviewRequests.nodes.some(
    (r) => r.requestedReviewer?.login === username,
  );
}

function isAssignedTo(candidate: PrSearchItem, username: string): boolean {
  return candidate.assignees.nodes.some((a) => a.login === username);
}

function toInfo(n: PrSearchItem, username: string): PullRequestInfo {
  return {
    owner: n.repository.owner.login,
    repo: n.repository.name,
    number: n.number,
    title: n.title,
    state: n.state,
    isCrossRepository: n.isCrossRepository,
    headRefOid: n.headRefOid,
    isReviewRequested: requiresReviewer(n, username),
    isAssignee: isAssignedTo(n, username),
  };
}

/**
 * Discovers open PRs across the given repositories/orgs where the current user
 * is a requested reviewer or assignee, excluding forks.
 */
export async function listCandidatePrs(
  client: GitHubClient,
  opts: { repo: string; orgs: string[]; username: string },
): Promise<PullRequestInfo[]> {
  const scopes: string[] = [];
  for (const org of opts.orgs) {
    scopes.push(scopeForOrg(org));
  }
  scopes.push(scopeForRepo(opts.repo));

  const reviewerQuery = scopes
    .map((s) => `(${s} review-requested:${opts.username})`)
    .join(" OR ");
  const assigneeQuery = scopes
    .map((s) => `(${s} assignee:${opts.username})`)
    .join(" OR ");
  const query = `is:pr is:open (${reviewerQuery} OR ${assigneeQuery})`;

  const response = await client.graphql<PrSearchResponse>(DISCOVERY_QUERY, { q: query });
  return response.search.nodes.filter((n) => !n.isCrossRepository).map((n) => toInfo(n, opts.username));
}

/**
 * Fetches a single PR by owner/repo/number regardless of open/closed state.
 */
export async function fetchPrByRef(
  client: GitHubClient,
  ref: PrRef,
  username: string,
): Promise<PullRequestInfo | undefined> {
  const response = await client.graphql<PrByRefResponse>(PR_BY_REF_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  });
  const pr = response.repository.pullRequest;
  if (pr === null) {
    return undefined;
  }
  return toInfo(pr, username);
}

export function scopeForRepo(repo: string): string {
  const [owner, name] = repo.split("/");
  return `repo:${owner}/${name}`;
}

export function scopeForOrg(org: string): string {
  return `org:${org}`;
}
