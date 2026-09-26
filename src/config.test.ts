import { describe, expect, it } from "vitest";
import { buildConfig, isRepoAllowed } from "./config.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildConfig", () => {
  it("uses default orgs", () => {
    const cfg = buildConfig({ skillPath: "skill.md" });
    expect(cfg.orgs).toEqual([]);
    expect(cfg.statePath).toMatch(/state\.json$/);
  });

  it("dedupes orgs and trims whitespace", () => {
    const cfg = buildConfig({ skillPath: "skill.md", orgs: [" alpha ", "alpha", "beta"] });
    expect(cfg.orgs).toEqual(["alpha", "beta"]);
  });

  it("rejects invalid org names", () => {
    expect(() => buildConfig({ skillPath: "skill.md", orgs: ["bad org!"] })).toThrow(/Invalid org/);
  });

  it("honors an explicit state path", () => {
    const statePath = join(tmpdir(), "ra-state.json");
    const cfg = buildConfig({ skillPath: "skill.md", statePath });
    expect(cfg.statePath).toBe(statePath);
  });
});

describe("isRepoAllowed", () => {
  it("allows repos in allowlisted orgs and rejects others", () => {
    const cfg = buildConfig({ skillPath: "skill.md", orgs: ["acme"] });
    expect(isRepoAllowed(cfg, "acme", "anything")).toBe(true);
    expect(isRepoAllowed(cfg, "dgp1130", "review-agent")).toBe(false);
    expect(isRepoAllowed(cfg, "other-org", "thing")).toBe(false);
  });
});
