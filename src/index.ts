import { parseArgs } from "./cli.js";
import { buildConfig, isRepoAllowed } from "./config.js";
import { assertGhAvailable, currentUser, defaultGhRunner, GhError } from "./github/auth.js";
import { GitHubClient } from "./github/client.js";
import { FileStateStore } from "./state/store.js";
import { parsePrUrl } from "./review/workflow.js";
import { reviewSinglePr } from "./review/runner.js";
import { readFileSync } from "node:fs";

async function fatal(err: unknown): Promise<number> {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.kind === "cli") {
    process.stderr.write(`${options.message}\n`);
    return 1;
  }

  try {
    await assertGhAvailable();
  } catch (err) {
    return fatal(err);
  }

  let username: string;
  try {
    username = await currentUser();
  } catch (err) {
    return fatal(err);
  }

  let config;
  try {
    config = buildConfig({
      skillPath: options.skillPath,
      repo: "dgp1130/review-agent",
      orgs: options.orgs,
    });
  } catch (err) {
    return fatal(err);
  }

  const client = new GitHubClient(defaultGhRunner);
  const stateStore = new FileStateStore(config.statePath, (m) => process.stdout.write(`${m}\n`));
  const state = stateStore.load();

  if (options.prUrl !== undefined) {
    const ref = parsePrUrl(options.prUrl);
    if (!ref) {
      return fatal(new Error(`Invalid PR URL: ${options.prUrl}`));
    }
    if (!isRepoAllowed(config, ref.owner, ref.repo)) {
      return fatal(
        new Error(
          `Refusing to review ${ref.owner}/${ref.repo}: not the default repo nor an allowlisted org (--orgs).`,
        ),
      );
    }
    try {
      const skillContent = readFileSync(config.skillPath, "utf8");
      const outcome = await reviewSinglePr(client, ref, username, state, {
        skillContent,
        config,
        allowListedOwners: config.orgs,
      });
      stateStore.save(state);
      process.stdout.write(
        `PR ${outcome.ref.owner}/${outcome.ref.repo}#${outcome.ref.number}: ${outcome.reason}\n`,
      );
      if (outcome.info && outcome.info.title) {
        process.stdout.write(`  title: ${outcome.info.title}\n  head:  ${outcome.info.headRefOid}\n`);
      }
      if (outcome.posted) {
        process.stdout.write(
          `  posted draft review ${outcome.posted.reviewId} (${outcome.posted.commentIds.length} comment(s), state=${outcome.posted.state})\n`,
        );
      }
      if (outcome.turns !== undefined) {
        process.stdout.write(`  agent turns: ${outcome.turns}\n`);
      }
      return 0;
    } catch (err) {
      return fatal(err);
    }
  }

  process.stdout.write(`reviewing as ${username}\n`);
  process.stdout.write(`skill: ${config.skillPath}\n`);
  process.stdout.write(`orgs: ${config.orgs.length > 0 ? config.orgs.join(", ") : "(none)"}\n`);
  process.stdout.write("review not yet implemented beyond scaffolding; run with --pr to test.\n");
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1].endsWith("index.js")) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

export { main };
