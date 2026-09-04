import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export interface Config {
  skillPath: string;
  repo: string;
  orgs: string[];
  /** Absolute path to the persistent state file (lives under dist/). */
  statePath: string;
}

const DEFAULT_REPO = "dgp1130/review-agent";

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
  repo?: string;
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
    repo: opts.repo ?? DEFAULT_REPO,
    orgs,
    statePath,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
