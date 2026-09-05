import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, getPr, putPr } from "./store.js";
import { emptyState, makePrRecord, prKey } from "./types.js";

describe("FileStateStore", () => {
  it("returns empty state when file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    const store = new FileStateStore(join(dir, "state.json"));
    expect(store.load()).toEqual(emptyState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers from a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    const path = join(dir, "state.json");
    writeFileSync(path, "{ not valid json", "utf8");
    const store = new FileStateStore(path, () => {});
    expect(store.load()).toEqual(emptyState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips state through save and load", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    const path = join(dir, "state.json");
    const store = new FileStateStore(path, () => {});
    const rec = makePrRecord("dgp1130", "review-agent", 42, "abc123");
    rec.messages = [{ role: "user", content: "hi" }];
    rec.draftCommentIds = ["c1"];
    rec.lastProbeAt = "2026-09-05T01:18:44.000Z";
    const state = putPr(emptyState(), rec);
    store.save(state);
    const loaded = store.load();
    expect(getPr(loaded, "dgp1130", "review-agent", 42)).toEqual(rec);
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a state file whose lastProbeAt is not a string", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    const path = join(dir, "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        prs: {
          [prKey("dgp1130", "review-agent", 42)]: {
            owner: "dgp1130",
            repo: "review-agent",
            number: 42,
            reviewedAt: "2026-09-05T00:00:00.000Z",
            lastReviewedCommitSha: "abc123",
            messages: [],
            draftCommentIds: [],
            lastProbeAt: 42,
          },
        },
      }),
      "utf8",
    );
    const store = new FileStateStore(path, () => {});
    expect(store.load()).toEqual(emptyState());
    rmSync(dir, { recursive: true, force: true });
  });

  it("prunes closed PRs by key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"));
    const store = new FileStateStore(join(dir, "state.json"), () => {});
    let state = putPr(emptyState(), makePrRecord("a", "r", 1, "x"));
    state = putPr(state, makePrRecord("b", "r", 2, "y"));
    const pruned = store.prune(state, new Set([prKey("a", "r", 1)]));
    expect(pruned.prs[prKey("a", "r", 1)]).toBeUndefined();
    expect(pruned.prs[prKey("b", "r", 2)]).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
