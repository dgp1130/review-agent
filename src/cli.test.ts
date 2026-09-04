import { describe, expect, it } from "vitest";
import { parseArgs, readSkillFile } from "./cli.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseArgs", () => {
  it("requires a skill path", () => {
    const result = parseArgs([]);
    expect(result.kind).toBe("cli");
  });

  it("parses a bare skill path", () => {
    const result = parseArgs(["skill.md"]);
    expect(result).toEqual({ kind: "ok", skillPath: "skill.md", prUrl: undefined, orgs: [] });
  });

  it("parses --pr and --orgs", () => {
    const result = parseArgs(["skill.md", "--pr", "https://github.com/a/b/pull/1", "--orgs", "alpha,beta"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "cli") return;
    expect(result.prUrl).toBe("https://github.com/a/b/pull/1");
    expect(result.orgs).toEqual(["alpha", "beta"]);
  });

  it("accepts --orgs with equals", () => {
    const result = parseArgs(["skill.md", "--orgs=alpha,beta"]);
    expect(result.kind).toBe("ok");
    if (result.kind === "cli") return;
    expect(result.orgs).toEqual(["alpha", "beta"]);
  });

  it("rejects unknown flags", () => {
    const result = parseArgs(["skill.md", "--nope"]);
    expect(result.kind).toBe("cli");
  });

  it("rejects multiple positional arguments", () => {
    const result = parseArgs(["a.md", "b.md"]);
    expect(result.kind).toBe("cli");
  });
});

describe("readSkillFile", () => {
  it("reads and returns file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-agent-"));
    const path = join(dir, "skill.md");
    writeFileSync(path, "# Rules\n\nBe polite.\n");
    expect(readSkillFile(path)).toContain("Be polite.");
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws for a missing file", () => {
    expect(() => readSkillFile("/nonexistent/skill.md")).toThrow(/does not exist/);
  });

  it("throws for an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-agent-"));
    const path = join(dir, "skill.md");
    writeFileSync(path, "   \n");
    expect(() => readSkillFile(path)).toThrow(/empty/);
    rmSync(dir, { recursive: true, force: true });
  });
});
