import { describe, expect, it } from "vitest";
import { listCandidatePrs, scopeForOrg, scopeForRepo } from "./prs.js";

interface FakeGraphQL {
  captureQuery: (query: string, variables: Record<string, unknown>) => unknown;
}

class FakeClient {
  constructor(private readonly handler: FakeGraphQL) {}

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return (await this.handler.captureQuery(query, variables ?? {})) as T;
  }
}

interface FakeSearchItem {
  number: number;
  title: string;
  state: string;
  isCrossRepository: boolean;
  headRefOid: string;
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  assignees: { nodes: { login?: string }[] };
  repository: { name: string; owner: { login: string } };
  headRepository: { name: string; owner: { login: string } } | null;
}

function node(overrides: Partial<FakeSearchItem> & { number: number }): FakeSearchItem {
  return {
    title: "t",
    state: "OPEN",
    isCrossRepository: false,
    headRefOid: "sha1",
    reviewRequests: { nodes: [] },
    assignees: { nodes: [] },
    repository: { name: "review-agent", owner: { login: "dgp1130" } },
    headRepository: { name: "review-agent", owner: { login: "dgp1130" } },
    ...overrides,
  };
}

describe("listCandidatePrs", () => {
  it("runs queries scoped to the default repo and each allowlisted org, for both qualifiers", async () => {
    const captured: string[] = [];
    const client = new FakeClient({
      captureQuery: (_query, variables) => {
        captured.push(String(variables.q));
        return { search: { nodes: [] } };
      },
    });
    await listCandidatePrs(client as never, { repo: "dgp1130/review-agent", orgs: ["acme"], username: "dgp1130" });
    // Expect one query per (scope, qualifier) pair: 2 scopes x 2 qualifiers.
    expect(captured).toHaveLength(4);
    const all = captured.join(" ");
    expect(all).toContain("repo:dgp1130/review-agent review-requested:dgp1130");
    expect(all).toContain("repo:dgp1130/review-agent assignee:dgp1130");
    expect(all).toContain("org:acme review-requested:dgp1130");
    expect(all).toContain("org:acme assignee:dgp1130");
  });

  it("includes cross-repository (fork) PRs found by the scoped search", async () => {
    const client = new FakeClient({
      captureQuery: () => ({
        search: {
          nodes: [
            node({ number: 1, isCrossRepository: false }),
            node({ number: 2, isCrossRepository: true }),
          ],
        },
      }),
    });
    const result = await listCandidatePrs(client as never, {
      repo: "dgp1130/review-agent",
      orgs: [],
      username: "dgp1130",
    });
    expect(result.map((p) => p.number)).toEqual([1, 2]);
  });

  it("flags review-requested and assigned PRs", async () => {
    const client = new FakeClient({
      captureQuery: () => ({
        search: {
          nodes: [
            node({
              number: 1,
              reviewRequests: { nodes: [{ requestedReviewer: { login: "dgp1130" } }] },
            }),
            node({
              number: 2,
              assignees: { nodes: [{ login: "dgp1130" }] },
            }),
          ],
        },
      }),
    });
    const result = await listCandidatePrs(client as never, {
      repo: "dgp1130/review-agent",
      orgs: [],
      username: "dgp1130",
    });
    expect(result[0].isReviewRequested).toBe(true);
    expect(result[0].isAssignee).toBe(false);
    expect(result[1].isAssignee).toBe(true);
    expect(result[1].isReviewRequested).toBe(false);
  });
});

describe("scopes", () => {
  it("formats repo and org scopes", () => {
    expect(scopeForRepo("a/b")).toBe("repo:a/b");
    expect(scopeForOrg("acme")).toBe("org:acme");
  });
});
