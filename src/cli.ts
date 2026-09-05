import { accessSync, readFileSync } from "node:fs";
import { parseArgs as nodeParseArgs } from "node:util";

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
  let values: { pr?: string; orgs?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = nodeParseArgs({
      args: argv,
      options: {
        pr: { type: "string" },
        orgs: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    return { kind: "cli", message: err instanceof Error ? err.message : String(err) };
  }

  if (values.help) {
    return { kind: "cli", message: usage() };
  }
  if (positionals.length > 1) {
    return { kind: "cli", message: "Too many positional arguments; expected a single skill file path." };
  }
  const skillPath = positionals[0];
  if (skillPath === undefined) {
    return { kind: "cli", message: usage() };
  }

  const orgs = values.orgs === undefined ? [] : values.orgs.split(",");
  return { kind: "ok", skillPath, prUrl: values.pr, orgs };
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
