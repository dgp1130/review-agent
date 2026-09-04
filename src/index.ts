import { parseArgs, usage } from "./cli.js";
import { assertGhAvailable, currentUser } from "./github/auth.js";

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.kind === "cli") {
    process.stderr.write(`${options.message}\n`);
    return 1;
  }

  // Startup validation: crash if gh is unavailable or unauthenticated.
  try {
    await assertGhAvailable();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let user: string;
  try {
    user = await currentUser();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(`reviewing as ${user}\n`);
  process.stdout.write(`skill: ${options.skillPath}\n`);
  process.stdout.write(`pr:   ${options.prUrl ?? "(none)"}\n`);
  process.stdout.write(`orgs: ${options.orgs.length > 0 ? options.orgs.join(", ") : "(none)"}\n`);
  process.stdout.write("scaffolding milestone reached; review not yet implemented.\n");
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1].endsWith("index.js")) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

export { main };
