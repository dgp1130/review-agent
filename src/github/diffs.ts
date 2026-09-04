import { GitHubClient } from "./client.js";

export interface PrFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff/patch for the file, if returned by the API. */
  patch?: string;
  /** Original filename when the file was renamed. */
  previous_filename?: string;
}

interface RestPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

interface RestContentsResponse {
  content?: string;
  encoding?: string;
  type?: string;
}

/**
 * Fetches the list of files changed by a PR, including each file's unified diff
 * patch when available. This is the context the review agent uses to target
 * comments to real diff lines and to feed the LLM.
 */
export async function fetchPrFiles(
  client: GitHubClient,
  opts: { owner: string; repo: string; number: number },
): Promise<PrFile[]> {
  const files = await client.rest<RestPrFile[]>(
    "GET",
    `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/files?per_page=100`,
  );
  return files.map((f) => ({
    filename: f.filename,
    status: normalizeStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
    previous_filename: f.previous_filename,
  }));
}

/**
 * Fetches the text content of a file at a given ref (commit SHA or branch) in a
 * repository, URL-encoding each path segment. Used by the constrained tools to
 * read a file at the PR's head commit.
 */
export async function fetchFileContent(
  client: GitHubClient,
  opts: { owner: string; repo: string; path: string; ref: string },
): Promise<string> {
  const encoded = opts.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const endpoint = `/repos/${opts.owner}/${opts.repo}/contents/${encoded}?ref=${encodeURIComponent(opts.ref)}`;
  const response = await client.rest<RestContentsResponse | RestContentsResponse[]>("GET", endpoint);
  if (Array.isArray(response)) {
    throw new Error(`Expected a file but found a directory at "${opts.path}".`);
  }
  if (response.type === "dir" || typeof response.content !== "string" || response.encoding !== "base64") {
    throw new Error(`Cannot read "${opts.path}": not a text file.`);
  }
  return Buffer.from(response.content, "base64").toString("utf8");
}

/**
 * Returns the set of new-file line numbers that are added (`+`) lines across all
 * hunks of a unified diff patch. These are the only lines GitHub accepts for an
 * inline draft comment on the right (new) side.
 */
export function addedLineNumbers(patch: string): Set<number> {
  const added = new Set<number>();
  const lines = patch.split("\n");
  let newStart: number | null = null;
  let cursor = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/.exec(line);
      if (!m) {
        continue;
      }
      newStart = Number(m[1]);
      cursor = newStart;
      continue;
    }
    if (newStart === null || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(cursor);
      cursor += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // No movement on the new side.
    } else if (line.startsWith(" ")) {
      cursor += 1;
    }
  }
  return added;
}

/**
 * Returns the first new-file line number added in a unified diff patch, or null
 * if there is no added line.
 */
export function firstAddedLine(patch: string): number | null {
  for (const line of addedLineNumbers(patch)) {
    return line;
  }
  return null;
}

function normalizeStatus(status: string): PrFile["status"] {
  switch (status) {
    case "added":
    case "modified":
    case "removed":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    default:
      return "changed";
  }
}
