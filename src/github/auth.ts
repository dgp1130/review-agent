import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhError";
  }
}

export interface GhRunner {
  (args: string[]): Promise<string>;
}

/**
 * Default runner: shells out to the `gh` CLI (already authenticated by the
 * user) and returns stdout. The harness may invoke `gh`; the LLM agent itself
 * is deliberately isolated from this in the tool surface.
 */
export function defaultGhRunner(args: string[]): Promise<string> {
  return execFileAsync("gh", args).then((r) => r.stdout);
}

/**
 * Validates that the `gh` CLI is installed and the user is authenticated.
 * Throws a GhError with a user-actionable message if either check fails.
 */
export async function assertGhAvailable(runGh: GhRunner = defaultGhRunner): Promise<void> {
  let output: string;
  try {
    output = await runGh(["--version"]);
  } catch {
    throw new GhError(
      "The `gh` CLI is required but could not be found on PATH. Install GitHub CLI (https://cli.github.com) and try again.",
    );
  }
  if (!output.includes("gh version")) {
    throw new GhError("Unexpected output from `gh --version`; aborting.");
  }
}

/**
 * Returns the login of the currently authenticated `gh` user.
 * Throws a GhError if the user is not authenticated.
 */
export async function currentUser(runGh: GhRunner = defaultGhRunner): Promise<string> {
  let stdout: string;
  try {
    stdout = await runGh(["api", "graphql", "-f", "query={ viewer { login } }"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GhError(
      `Could not determine the authenticated GitHub user. Ensure you are logged in with \`gh auth login\`.\n${msg}`,
    );
  }
  let parsed: { data?: { viewer?: { login?: string } } };
  try {
    parsed = JSON.parse(stdout) as { data?: { viewer?: { login?: string } } };
  } catch {
    throw new GhError("The `gh` CLI returned invalid JSON while resolving the user.");
  }
  const login = parsed.data?.viewer?.login;
  if (!login) {
    throw new GhError("The `gh` CLI returned no authenticated user.");
  }
  return login;
}
