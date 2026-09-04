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
