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
    ...overrides,
  };
}

describe("listCandidatePrs", () => {
  it("builds a query scoped to the default repo and allowlisted orgs", async () => {
    let captured: string | undefined;
    const client = new FakeClient({
      captureQuery: (_query, variables) => {
        captured = String(variables.q);
        return { search: { nodes: [] } };
      },
    });
    await listCandidatePrs(client as never, { repo: "dgp1130/review-agent", orgs: ["acme"], username: "dgp1130" });
    expect(captured).toContain("repo:dgp1130/review-agent");
    expect(captured).toContain("org:acme");
  });

  it("excludes cross-repository (fork) PRs", async () => {
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
    expect(result.map((p) => p.number)).toEqual([1]);
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
