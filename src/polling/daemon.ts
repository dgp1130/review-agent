import { GitHubClient } from "../github/client.js";
import { listCandidatePrs, fetchPrByRef, PullRequestInfo } from "../github/prs.js";
import { reviewSinglePr } from "../review/runner.js";
import { State, prKey } from "../state/types.js";
import { StateStore } from "../state/store.js";
import { Config } from "../config.js";
import { ChatProvider } from "../llm/types.js";

export interface DaemonOptions {
  client: GitHubClient;
  config: Config;
  username: string;
  skillContent: string;
  state: State;
  stateStore: StateStore;
  /** Cadence between ticks. Defaults to 30s (the hard-coded daemon interval). */
  intervalMs?: number;
  provider?: ChatProvider;
  onLog?: (message: string) => void;
}

export interface TickSummary {
  discovered: number;
  reviewed: number;
  skipped: number;
  errors: number;
  pruned: number;
}

function log(opts: DaemonOptions, message: string): void {
  opts.onLog?.(message);
}

/**
 * One daemon tick: discover candidate PRs, evaluate each, review the ones that
 * need it, and prune state for closed/merged PRs. Returns a summary of what
 * happened. Errors on any single PR are caught and counted so one bad PR never
 * aborts the whole poll.
 */
export async function runTick(opts: DaemonOptions): Promise<TickSummary> {
  const summary: TickSummary = { discovered: 0, reviewed: 0, skipped: 0, errors: 0, pruned: 0 };

  const candidates = await listCandidatePrs(opts.client, {
    repo: opts.config.repo,
    orgs: opts.config.orgs,
    username: opts.username,
  });
  summary.discovered = candidates.length;

  for (const candidate of candidates) {
    const ref = { owner: candidate.owner, repo: candidate.repo, number: candidate.number };
    try {
      const outcome = await reviewSinglePr(opts.client, ref, opts.username, opts.state, {
        skillContent: opts.skillContent,
        config: opts.config,
        allowListedOwners: opts.config.orgs,
        provider: opts.provider,
      });
      if (outcome.shouldReview) {
        summary.reviewed += 1;
        log(opts, `  reviewed ${ref.owner}/${ref.repo}#${ref.number}: ${outcome.reason}`);
      } else {
        summary.skipped += 1;
        log(opts, `  skipped ${ref.owner}/${ref.repo}#${ref.number}: ${outcome.reason}`);
      }
    } catch (err) {
      summary.errors += 1;
      log(opts, `  error on ${ref.owner}/${ref.repo}#${ref.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  summary.pruned += (await pruneClosedPrs(opts, candidates)).length;

  opts.stateStore.save(opts.state);
  return summary;
}

/**
 * Removes state records for PRs that are no longer open. A record may be absent
 * from the candidate list either because the PR closed/merged or because the
 * current user's involvement ended while the PR stayed open; we only prune the
 * former, verified by fetching each such PR's state.
 *
 * To avoid hammering GitHub every tick, each dropped PR is probed at most once:
 * the first time it leaves the candidate list its state is fetched, pruned if
 * closed/merged, and otherwise stamped with `lastProbeAt`. Once stamped, the
 * daemon stops querying the PR (the user was removed from an open PR) but keeps
 * the pending review state so a dropped review can still be answered. The
 * stamp is cleared while the PR is an active candidate again, so a PR that
 * closes while the user is involved is re-probed and reaped on its next drop.
 */
export async function pruneClosedPrs(opts: DaemonOptions, candidates: PullRequestInfo[]): Promise<string[]> {
  const candidateKeys = new Set<string>();
  for (const c of candidates) {
    const key = prKey(c.owner, c.repo, c.number);
    candidateKeys.add(key);
    const record = opts.state.prs[key];
    if (record?.lastProbeAt !== undefined) {
      record.lastProbeAt = undefined;
    }
  }

  const closedKeys = new Set<string>();
  for (const [key, record] of Object.entries(opts.state.prs)) {
    if (candidateKeys.has(key)) {
      continue;
    }
    if (record.lastProbeAt !== undefined) {
      continue;
    }
    try {
      const info = await fetchPrByRef(opts.client, { owner: record.owner, repo: record.repo, number: record.number }, opts.username);
      if (info && info.state !== "OPEN") {
        closedKeys.add(key);
      } else {
        record.lastProbeAt = new Date().toISOString();
      }
    } catch (err) {
      log(opts, `  could not check state of ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (closedKeys.size > 0) {
    const pruned = opts.stateStore.prune(opts.state, closedKeys);
    Object.assign(opts.state, pruned);
  }
  return [...closedKeys];
}

export interface DaemonHandle {
  stop(): void;
  /** Resolves when the daemon has stopped after a graceful shutdown. */
  done: Promise<void>;
}

/**
 * Runs the daemon in a loop: `intervalMs` between ticks, forever, until
 * `stop()` is called (typically from a SIGINT/SIGTERM handler). State is saved
 * every tick.
 */
export function runDaemon(opts: DaemonOptions): DaemonHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  let stopped = false;
  let stopSleep: (() => void) | undefined;

  const tickOnce = async (): Promise<void> => {
    try {
      const summary = await runTick(opts);
      log(
        opts,
        `tick: discovered=${summary.discovered} reviewed=${summary.reviewed} skipped=${summary.skipped} errors=${summary.errors} pruned=${summary.pruned}`,
      );
    } catch (err) {
      log(opts, `tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await tickOnce();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stopSleep = undefined;
          resolve();
        }, intervalMs);
        stopSleep = () => {
          clearTimeout(timer);
          stopSleep = undefined;
          resolve();
        };
      });
    }
  };

  const done = loop();

  return {
    stop(): void {
      stopped = true;
      stopSleep?.();
    },
    done,
  };
}