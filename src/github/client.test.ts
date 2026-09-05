import { describe, expect, it } from "vitest";
import { GitHubClient, isTransientFailure, GraphQLError } from "./client.js";

function failWith(message: string): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

describe("isTransientFailure", () => {
  it("accepts rate limits, HTTP 5xx/429, and network errors", () => {
    expect(isTransientFailure(new Error("API rate limit exceeded for user..."))).toBe(true);
    expect(isTransientFailure(new Error("HTTP 502"))).toBe(true);
    expect(isTransientFailure(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientFailure(new Error("request timed out"))).toBe(true);
    expect(isTransientFailure(new Error("connect ECONNRESET"))).toBe(true);
  });

  it("rejects fatal errors", () => {
    expect(isTransientFailure(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(isTransientFailure(new Error("Not Found"))).toBe(false);
    expect(isTransientFailure(new Error("Bad credentials"))).toBe(false);
  });
});

describe("GitHubClient retry", () => {
  it("retries transient failures with backoff and eventually succeeds", async () => {
    let calls = 0;
    const client = new GitHubClient(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("API rate limit exceeded");
        }
        return '{"data": {"ok": true}}';
      },
      { attempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
    );

    const data = await client.graphql<{ ok: boolean }>("q");
    expect(data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("returns the last error after exhausting retries", async () => {
    const client = new GitHubClient(failWith("API rate limit exceeded"), {
      attempts: 3,
      baseDelayMs: 2,
      maxDelayMs: 4,
    });

    await expect(client.graphql("q")).rejects.toThrow("API rate limit exceeded");
  });

  it("does not retry fatal errors", async () => {
    let calls = 0;
    const client = new GitHubClient(async () => {
      calls += 1;
      throw new Error("Not Found");
    });

    await expect(client.graphql("q")).rejects.toThrow("Not Found");
    expect(calls).toBe(1);
  });

  it("retries REST calls with a body via the temp-file path", async () => {
    let calls = 0;
    const client = new GitHubClient(
      async (args: string[]) => {
        const isCreate = args.includes("--input");
        void isCreate;
        calls += 1;
        if (calls === 1) {
          throw new Error("HTTP 503 Service Unavailable");
        }
        return '{"id": 1}';
      },
      { attempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
    );

    const result = await client.rest<{ id: number }>("POST", "/repos/x/y/pulls/1/reviews", {
      comments: [],
    });
    expect(result.id).toBe(1);
    expect(calls).toBe(2);
  });

  it("still surfaces GraphQL API errors (non-transient data errors)", async () => {
    const client = new GitHubClient(async () =>
      JSON.stringify({ data: null, errors: [{ message: "field not found" }] }),
    );
    await expect(client.graphql("q")).rejects.toBeInstanceOf(GraphQLError);
  });
});