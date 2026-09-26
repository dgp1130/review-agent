import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export interface Config {
  skillPath: string;
  orgs: string[];
  /** Absolute path to the persistent state file (lives under dist/). */
  statePath: string;
}

/**
 * Resolves the state file path to be inside dist/, matching the compiled output
 * directory so it is automatically gitignored alongside build output.
 */
export function defaultStatePath(): string {
  const distDir = dirname(fileURLToPath(import.meta.url));
  return resolve(distDir, "state.json");
}

export function buildConfig(opts: {
  skillPath: string;
  orgs?: string[];
  statePath?: string;
}): Config {
  const orgs = dedupe((opts.orgs ?? []).map((o) => o.trim()).filter((o) => o.length > 0));
  const orgsValid = orgs.every((o) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(o));
  if (!orgsValid) {
    throw new Error(`Invalid org name in --orgs: ${orgs.join(", ")}`);
  }

  const statePath = opts.statePath ?? defaultStatePath();
  mkdirSync(dirname(statePath), { recursive: true });

  return {
    skillPath: opts.skillPath,
    orgs,
    statePath,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Whether a repository (owner/name) is in scope for posting comments and
 * monitoring: it must belong to an allowlisted org. This gates every repo the
 * agent may touch regardless of how a PR was discovered (including the `--pr`
 * mode and fork PRs).
 */
export function isRepoAllowed(config: Config, owner: string, _name?: string): boolean {
  return config.orgs.includes(owner);
}
