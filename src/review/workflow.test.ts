import { describe, expect, it } from "vitest";
import { parsePrUrl, needsReview, recordKey } from "./workflow.js";
import { makePrRecord } from "../state/types.js";

describe("parsePrUrl", () => {
  it("parses a valid GitHub PR URL", () => {
    expect(parsePrUrl("https://github.com/dgp1130/review-agent/pull/12")).toEqual({
      owner: "dgp1130",
      repo: "review-agent",
      number: 12,
    });
  });

  it("handles trailing slashes", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/3/")).toEqual({ owner: "a", repo: "b", number: 3 });
  });

  it("rejects non-PR URLs", () => {
    expect(parsePrUrl("https://github.com/a/b/issues/3")).toBeUndefined();
    expect(parsePrUrl("not a url")).toBeUndefined();
  });
});

describe("needsReview", () => {
  it("needs review when no prior record", () => {
    expect(needsReview("sha1", undefined)).toBe(true);
  });

  it("does not need review when head SHA unchanged", () => {
    const rec = makePrRecord("a", "b", 1, "sha1");
    expect(needsReview("sha1", rec)).toBe(false);
  });

  it("needs review when head SHA changed since last review", () => {
    const rec = makePrRecord("a", "b", 1, "sha1");
    expect(needsReview("sha2", rec)).toBe(true);
  });
});

describe("recordKey", () => {
  it("formats the key uniquely", () => {
    expect(recordKey("dgp1130", "review-agent", 5)).toBe("dgp1130/review-agent#5");
  });
});
