import { describe, expect, it } from "vitest";
import { assertGhAvailable, currentUser, GhError } from "./auth.js";

function okRun(args: string[], stdout: string): (a: string[]) => Promise<string> {
  return async (actualArgs: string[]) => {
    expect(actualArgs).toEqual(args);
    return stdout;
  };
}

describe("assertGhAvailable", () => {
  it("passes when gh is installed", async () => {
    await expect(assertGhAvailable(okRun(["--version"], "gh version 2.0.0\n"))).resolves.toBeUndefined();
  });

  it("throws when gh is missing", async () => {
    await expect(assertGhAvailable(() => Promise.reject(new Error("ENOENT")))).rejects.toBeInstanceOf(GhError);
  });

  it("throws when output is not gh version text", async () => {
    await expect(assertGhAvailable(okRun(["--version"], "unexpected"))).rejects.toBeInstanceOf(GhError);
  });
});

describe("currentUser", () => {
  it("returns the viewer login", async () => {
    const login = await currentUser(
      okRun(["api", "graphql", "-f", "query={ viewer { login } }"], JSON.stringify({ data: { viewer: { login: "dgp1130" } } })),
    );
    expect(login).toBe("dgp1130");
  });

  it("throws a GhError when not authenticated", async () => {
    await expect(currentUser(() => Promise.reject(new Error("not logged in")))).rejects.toBeInstanceOf(GhError);
  });

  it("throws a GhError on invalid JSON", async () => {
    await expect(currentUser(okRun(["api", "graphql", "-f", "query={ viewer { login } }"], "not json"))).rejects.toBeInstanceOf(GhError);
  });
});
