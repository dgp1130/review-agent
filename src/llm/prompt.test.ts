import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, PromptPrInfo } from "./prompt.js";
import { PrFile } from "../github/diffs.js";

const pr: PromptPrInfo = {
  owner: "dgp1130",
  repo: "review-agent",
  number: 10,
  title: "M3 test",
  author: "dgp1130-test",
  headSha: "abc123",
  body: "Adds utilities.",
};

describe("buildSystemPrompt", () => {
  it("renders skill content verbatim", () => {
    const skill = "Look for: correctness.\nPrefer explicit error handling.";
    const prompt = buildSystemPrompt(skill);
    expect(prompt).toContain(skill);
    expect(prompt).toContain("Look for: correctness.");
  });

  it("stays unopinionated about review criteria in the primer", () => {
    // The primer must not inject opinions about what a good review contains.
    const prompt = buildSystemPrompt("Some skill.");
    const primer = prompt.slice(prompt.indexOf("## How to use the tools"));
    for (const opinion of ["always add tests", "check naming conventions", "must lint", "require coverage"]) {
      expect(primer.toLowerCase()).not.toContain(opinion);
    }
  });

  it("describes draft-only mechanics", () => {
    const prompt = buildSystemPrompt("Skill");
    expect(prompt).toMatch(/pending review/i);
    expect(prompt).toMatch(/never submitted/i);
    expect(prompt).toMatch(/top-level review body/i);
  });
});

describe("buildUserPrompt", () => {
  function file(filename: string, patch: string): PrFile {
    return { filename, status: "added", additions: 1, deletions: 0, changes: 1, patch };
  }

  it("includes PR metadata, diffs, and existing comments", () => {
    const prompt = buildUserPrompt({
      pr,
      files: [file("M3-test/format.js", "@@ -0,0 +1,3 @@\n+a\n+b\n+c")],
      existingComments: [
        { id: 1, path: "M3-test/format.js", line: 2, body: "already said this", created_at: "t" },
      ],
    });
    expect(prompt).toContain("PR #10: M3 test");
    expect(prompt).toContain("by dgp1130-test");
    expect(prompt).toContain("+a");
    expect(prompt).toContain("already said this");
    expect(prompt).toContain("Do not repeat these");
  });

  it("handles empty diffs and comments", () => {
    const prompt = buildUserPrompt({ pr, files: [], existingComments: [] });
    expect(prompt).toContain("(no changed files)");
    expect(prompt).toContain("(none)");
  });
});