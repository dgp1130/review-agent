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

export interface RetryPolicy {
  /** Total attempts per call (including the first). */
  attempts: number;
  /** Delay before the first retry, doubled each retry (with jitter). */
  baseDelayMs: number;
  /** Upper bound on the per-attempt delay. */
  maxDelayMs: number;
}

const DEFAULT_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 250, maxDelayMs: 4000 };

/** Returns true when a failure is worth a retry (rate limits, 5xx, network). */
export function isTransientFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/rate limit/i.test(message) || /HTTP (429|5\d\d)/.test(message)) {
    return true;
  }
  return /timed? ?out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|failed to connect/i.test(message);
}

/**
 * Thin wrapper over the `gh` CLI for GitHub API access. The harness invokes
 * `gh`; the LLM agent is deliberately kept away from this layer (it only sees
 * the constrained tools built on top of it).
 */
export class GitHubClient {
  private readonly policy: RetryPolicy;

  constructor(
    private readonly runGh: GhRunner,
    policy?: Partial<RetryPolicy>,
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * Runs a GraphQL query with optional variables using `gh api graphql`.
   * Returns the `data` object, throwing a GraphQLError on API errors. Rate
   * limits and other transient failures are retried with exponential backoff.
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
    const stdout = await this.retry(() => this.runGh(args));
    const parsed = JSON.parse(stdout) as { data?: T; errors?: unknown };
    if (parsed.errors) {
      throw new GraphQLError("GitHub GraphQL returned errors.", parsed.errors);
    }
    return parsed.data as T;
  }

  /**
   * Runs a REST API call with a JSON body (passed via a temp file to avoid
   * shell-quoting issues). Rate limits and other transient failures are
   * retried with exponential backoff.
   */
  async rest<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    if (body === undefined) {
      const stdout = await this.retry(() => this.runGh(["api", "--method", method, endpoint]));
      return JSON.parse(stdout) as T;
    }
    const dir = mkdtempSync(join(tmpdir(), "review-agent-"));
    const bodyPath = join(dir, "body.json");
    writeFileSync(bodyPath, JSON.stringify(body), "utf8");
    try {
      const stdout = await this.retry(() =>
        this.runGh(["api", "--method", method, endpoint, "--input", bodyPath]),
      );
      return JSON.parse(stdout) as T;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async retry<T>(attempt: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.policy.attempts; i += 1) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        if (i === this.policy.attempts - 1 || !isTransientFailure(err)) {
          throw err;
        }
        const delay =
          Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** i) + Math.random() * 50;
        await sleep(delay);
      }
    }
    throw lastErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
