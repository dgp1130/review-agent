import { accessSync, readFileSync } from "node:fs";

export interface CliOptions {
  kind: "ok";
  skillPath: string;
  prUrl?: string;
  orgs: string[];
}

export interface CliError {
  kind: "cli";
  message: string;
}

export type CliResult = CliOptions | CliError;

export function parseArgs(argv: string[]): CliResult {
  const orgs: string[] = [];
  let skillPath: string | undefined;
  let prUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pr") {
      const value = argv[++i];
      if (value === undefined) {
        return { kind: "cli", message: "--pr requires a PR URL argument." };
      }
      prUrl = value;
    } else if (arg.startsWith("--orgs=")) {
      orgs.push(...arg.slice("--orgs=".length).split(","));
    } else if (arg === "--orgs") {
      const value = argv[++i];
      if (value === undefined) {
        return { kind: "cli", message: "--orgs requires a comma-separated list argument." };
      }
      orgs.push(...value.split(","));
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "cli", message: usage() };
    } else if (arg.startsWith("--")) {
      return { kind: "cli", message: `Unknown option: ${arg}` };
    } else {
      if (skillPath !== undefined) {
        return { kind: "cli", message: "Too many positional arguments; expected a single skill file path." };
      }
      skillPath = arg;
    }
  }

  if (skillPath === undefined) {
    return { kind: "cli", message: usage() };
  }

  return { kind: "ok", skillPath, prUrl, orgs };
}

export function usage(): string {
  return [
    "Usage: review-agent <skill.md> [--pr <url>] [--orgs org1,org2,...]",
    "",
    "  <skill.md>       Path to a skill/Markdown file whose content guides the review.",
    "  --pr <url>       Review a single PR and exit (e.g. https://github.com/OWNER/REPO/pull/123).",
    "  --orgs <list>    Comma-separated GitHub orgs to monitor for PRs in addition to the",
    "                   default repository.",
  ].join("\n");
}

export function readSkillFile(skillPath: string): string {
  try {
    accessSync(skillPath);
  } catch {
    throw new Error(`Skill file does not exist or is not readable: ${skillPath}`);
  }
  const content = readFileSync(skillPath, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`Skill file is empty: ${skillPath}`);
  }
  return content;
}
