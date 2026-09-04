import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhRunner } from "./auth.js";

export class GraphQLError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "GraphQLError";
    this.details = details;
  }
}

/**
 * Thin wrapper over the `gh` CLI for GitHub API access. The harness invokes
 * `gh`; the LLM agent is deliberately kept away from this layer (it only sees
 * the constrained tools built on top of it).
 */
export class GitHubClient {
  constructor(private readonly runGh: GhRunner) {}

  /**
   * Runs a GraphQL query with optional variables using `gh api graphql`.
   * Returns the `data` object, throwing a GraphQLError on API errors.
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables ?? {})) {
      if (typeof value === "string") {
        args.push("-F", `${key}=${value}`);
      } else {
        args.push(`-F${key}=${JSON.stringify(value)}`);
      }
    }
    const stdout = await this.runGh(args);
    const parsed = JSON.parse(stdout) as { data?: T; errors?: unknown };
    if (parsed.errors) {
      throw new GraphQLError("GitHub GraphQL returned errors.", parsed.errors);
    }
    return parsed.data as T;
  }

  /**
   * Runs a REST API call with a JSON body (passed via a temp file to avoid
   * shell-quoting issues).
   */
  async rest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    if (body === undefined) {
      const stdout = await this.runGh(["api", "--method", method, endpoint]);
      return JSON.parse(stdout) as T;
    }
    const dir = mkdtempSync(join(tmpdir(), "review-agent-"));
    const bodyPath = join(dir, "body.json");
    writeFileSync(bodyPath, JSON.stringify(body), "utf8");
    try {
      const stdout = await this.runGh(["api", "--method", method, endpoint, "--input", bodyPath]);
      return JSON.parse(stdout) as T;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
