import { describe, expect, it } from "vitest";
import { runTick, pruneClosedPrs } from "./daemon.js";
import { PullRequestInfo } from "../github/prs.js";
import { emptyState, makePrRecord, prKey, State } from "../state/types.js";
import { StateStore } from "../state/store.js";
import { Config } from "../config.js";
import { ChatProvider } from "../llm/types.js";

function info(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    owner: "dgp1130",
    repo: "review-agent",
    number: 1,
    title: "t",
    state: "OPEN",
    isCrossRepository: false,
    headRefOid: "sha1",
    headOwner: "dgp1130",
    headRepo: "review-agent",
    isReviewRequested: true,
    isAssignee: false,
    ...overrides,
  };
}

type RawNode = Omit<PullRequestInfo, "isReviewRequested" | "isAssignee"> & {
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  assignees: { nodes: { login?: string }[] };
  repository: { name: string; owner: { login: string } };
  headRepository: { name: string; owner: { login: string } };
};

function rawNode(p: PullRequestInfo): RawNode {
  return {
    owner: p.owner,
    repo: p.repo,
    number: p.number,
    title: p.title,
    state: p.state,
    isCrossRepository: p.isCrossRepository,
    headRefOid: p.headRefOid,
    headOwner: p.headOwner,
    headRepo: p.headRepo,
    reviewRequests: { nodes: p.isReviewRequested ? [{ requestedReviewer: { login: "dgp1130" } }] : [] },
    assignees: { nodes: p.isAssignee ? [{ login: "dgp1130" }] : [] },
    repository: { name: p.repo, owner: { login: p.owner } },
    headRepository: { name: p.headRepo, owner: { login: p.headOwner } },
  };
}

const FILES: unknown[] = [
  { filename: "M1-test.txt", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ -0,0 +1,3 @@\n+# Test\n+\n+more" },
];

/** Fake client: `graphql` serves both discovery (search) and by-ref queries. */
class FakeClient {
  constructor(
    private readonly candidates: RawNode[],
    private readonly byRef: (number: number) => RawNode | undefined,
  ) {}

  async graphql<T>(query: string, vars: { q?: string }): Promise<T> {
    if (typeof vars.q === "string") {
      return { search: { nodes: this.candidates } } as T;
    }
    const number = (vars as { number: number }).number;
    const node = this.byRef(number) ?? this.candidates.find((c) => c.number === number);
    return { repository: { pullRequest: node ?? null } } as T;
  }

  async rest<T>(method: string, endpoint: string, _body?: unknown): Promise<T> {
    if (method === "GET" && endpoint.includes("/files?per_page=100")) {
      return FILES as T;
    }
    if (method === "GET" && endpoint.includes("/pulls/")) {
      return [] as T;
    }
    if (method === "POST" && endpoint.endsWith("/reviews")) {
      return { id: 42, state: "PENDING" } as T;
    }
    return FILES as T;
  }
}

function makeConfig(): Config {
  return {
    skillPath: "SKILL.md",
    repo: "dgp1130/review-agent",
    orgs: [],
    statePath: "/tmp/state-daemon.json",
  };
}

/** Provider that never posts comments; records the summaries it produced. */
function textProvider(summaries: string[]): ChatProvider {
  return {
    complete: async () => ({ content: summaries.shift() ?? "No findings.", toolCalls: [] }),
  };
}

function throwingProvider(): ChatProvider {
  return {
    complete: async () => {
      throw new Error("boom");
    },
  };
}

class RecordingStore implements StateStore {
  saves = 0;
  load(): State {
    return emptyState();
  }
  save(_state: State): void {
    this.saves += 1;
  }
  prune(state: State, closedKeys: Set<string>): State {
    const prs: State["prs"] = {};
    for (const [key, record] of Object.entries(state.prs)) {
      if (!closedKeys.has(key)) {
        prs[key] = record;
      }
    }
    return { ...state, prs };
  }
}

function makeOpts(overrides: Partial<Parameters<typeof runTick>[0]> = {}): Parameters<typeof runTick>[0] {
  return {
    client: new FakeClient([], () => undefined) as never,
    config: makeConfig(),
    username: "dgp1130",
    skillContent: "# Review skill",
    state: emptyState(),
    stateStore: new RecordingStore(),
    onLog: () => {},
    ...overrides,
  };
}

describe("runTick", () => {
  it("discovers and reviews a candidate PR, then saves state", async () => {
    const state = emptyState();
    const store = new RecordingStore();
    const opts = makeOpts({
      client: new FakeClient([rawNode(info({ number: 9, headRefOid: "sha0" }))], () => undefined) as never,
      state,
      stateStore: store,
      provider: textProvider(["Found it."]),
    });

    const summary = await runTick(opts);

    expect(summary).toEqual({ discovered: 1, reviewed: 1, skipped: 0, errors: 0, pruned: 0 });
    expect(store.saves).toBeGreaterThan(0);
    const record = state.prs[prKey("dgp1130", "review-agent", 9)];
    expect(record.lastReviewedCommitSha).toBe("sha0");
  });

  it("skips candidates already reviewed at their head SHA", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 9)] = makePrRecord("dgp1130", "review-agent", 9, "sha0");
    const opts = makeOpts({
      client: new FakeClient([rawNode(info({ number: 9, headRefOid: "sha0" }))], () => undefined) as never,
      state,
      provider: textProvider(["Should not run."]),
    });

    const summary = await runTick(opts);

    expect(summary.discovered).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.reviewed).toBe(0);
  });

  it("counts per-PR errors and keeps polling other PRs", async () => {
    const opts = makeOpts({
      client: new FakeClient(
        [rawNode(info({ number: 9, headRefOid: "sha0" })), rawNode(info({ number: 10, headRefOid: "sha1" }))],
        () => undefined,
      ) as never,
      provider: throwingProvider(),
    });

    const summary = await runTick(opts);

    expect(summary.reviewed).toBe(0);
    expect(summary.errors).toBe(2);
  });

  it("prunes nothing when all records are still open", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 9)] = makePrRecord("dgp1130", "review-agent", 9, "sha0");
    const opts = makeOpts({
      client: new FakeClient(
        [rawNode(info({ number: 9, headRefOid: "sha0" }))],
        (n) => (n === 9 ? rawNode(info({ number: 9, headRefOid: "sha0" })) : undefined),
      ) as never,
      state,
    });

    const summary = await runTick(opts);

    expect(summary.pruned).toBe(0);
    expect(state.prs[prKey("dgp1130", "review-agent", 9)]).toBeDefined();
  });
});

describe("pruneClosedPrs", () => {
  it("removes records whose PR is closed", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 5)] = makePrRecord("dgp1130", "review-agent", 5, "sha0");
    const opts = makeOpts({
      client: new FakeClient([], (n) => {
        if (n === 5) {
          return rawNode(info({ number: 5, headRefOid: "sha0", state: "CLOSED" }));
        }
        return undefined;
      }) as never,
      state,
    });

    const pruned = await pruneClosedPrs(opts, []);

    expect(pruned).toEqual([prKey("dgp1130", "review-agent", 5)]);
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]).toBeUndefined();
  });

  it("keeps a record that is simply absent from discovery", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 5)] = makePrRecord("dgp1130", "review-agent", 5, "sha0");
    let probes = 0;
    const opts = makeOpts({
      client: new FakeClient([], () => {
        probes += 1;
        return rawNode(info({ number: 5, headRefOid: "sha0", state: "OPEN" }));
      }) as never,
      state,
    });

    const pruned = await pruneClosedPrs(opts, []);

    expect(pruned).toEqual([]);
    expect(probes).toBe(1);
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]).toBeDefined();
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]?.lastProbeAt).toBeDefined();
  });

  it("does not re-probe a record already confirmed open after it left candidates", async () => {
    const state = emptyState();
    const rec = makePrRecord("dgp1130", "review-agent", 5, "sha0");
    rec.lastProbeAt = new Date().toISOString();
    state.prs[prKey("dgp1130", "review-agent", 5)] = rec;
    let probes = 0;
    const opts = makeOpts({
      client: new FakeClient([], () => {
        probes += 1;
        return rawNode(info({ number: 5, headRefOid: "sha0", state: "OPEN" }));
      }) as never,
      state,
    });

    const pruned = await pruneClosedPrs(opts, []);

    expect(pruned).toEqual([]);
    expect(probes).toBe(0);
    expect(rec.lastProbeAt).toBeDefined();
  });

  it("clears the probe stamp while a candidate and re-probes a later close", async () => {
    const state = emptyState();
    state.prs[prKey("dgp1130", "review-agent", 5)] = makePrRecord("dgp1130", "review-agent", 5, "sha0");
    let byRef: RawNode | undefined = rawNode(info({ number: 5, headRefOid: "sha0", state: "OPEN" }));
    const makeClient = () =>
      new FakeClient([], (n) => {
        return n === 5 ? byRef : undefined;
      }) as never;

    // First drop: the PR is open, so it is stamped to stop re-probing.
    await pruneClosedPrs(makeOpts({ client: makeClient(), state }), []);
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]?.lastProbeAt).toBeDefined();

    // Re-involved: the candidate clears the stamp for a fresh probe on the next drop.
    await pruneClosedPrs(makeOpts({ client: makeClient(), state }), [info({ number: 5, headRefOid: "sha0" })]);
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]?.lastProbeAt).toBeUndefined();

    // The PR closes after the user loses involvement again: it is now reaped.
    byRef = rawNode(info({ number: 5, headRefOid: "sha0", state: "CLOSED" }));
    const pruned = await pruneClosedPrs(makeOpts({ client: makeClient(), state }), []);

    expect(pruned).toEqual([prKey("dgp1130", "review-agent", 5)]);
    expect(state.prs[prKey("dgp1130", "review-agent", 5)]).toBeUndefined();
  });
});