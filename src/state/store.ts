import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, prKey, State, PrRecord } from "./types.js";

export interface StateStore {
  load(): State;
  save(state: State): void;
  /** Remove PR records for closed/merged PRs (identified by the caller). */
  prune(state: State, closedKeys: Set<string>): State;
}

export interface StateLogger {
  (message: string): void;
}

export class FileStateStore implements StateStore {
  constructor(
    private readonly statePath: string,
    private readonly logger: StateLogger = () => {},
  ) {}

  load(): State {
    if (!existsSync(this.statePath)) {
      return emptyState();
    }
    let text: string;
    try {
      text = readFileSync(this.statePath, "utf8");
    } catch (err) {
      this.logger(`Warning: could not read state file, starting fresh: ${String(err)}`);
      return emptyState();
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isState(parsed)) {
        throw new Error("state file has unexpected shape");
      }
      return parsed;
    } catch (err) {
      this.logger(`Warning: corrupted state file, starting fresh: ${String(err)}`);
      return emptyState();
    }
  }

  save(state: State): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  prune(state: State, closedKeys: Set<string>): State {
    if (closedKeys.size === 0) {
      return state;
    }
    const prs: Record<string, PrRecord> = {};
    for (const [key, record] of Object.entries(state.prs)) {
      if (!closedKeys.has(key)) {
        prs[key] = record;
      }
    }
    return { ...state, prs };
  }
}

export function getPr(state: State, owner: string, repo: string, number: number): PrRecord | undefined {
  return state.prs[prKey(owner, repo, number)];
}

export function putPr(state: State, record: PrRecord): State {
  const key = prKey(record.owner, record.repo, record.number);
  const prs = { ...state.prs, [key]: record };
  return { ...state, prs };
}

function isState(value: unknown): value is State {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<State>;
  if (typeof candidate.prs !== "object" || candidate.prs === null) {
    return false;
  }
  for (const record of Object.values(candidate.prs as Record<string, unknown>)) {
    if (!isPrRecord(record)) {
      return false;
    }
  }
  return true;
}

function isPrRecord(value: unknown): value is PrRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PrRecord>;
  return (
    typeof candidate.owner === "string" &&
    typeof candidate.repo === "string" &&
    typeof candidate.number === "number" &&
    typeof candidate.reviewedAt === "string" &&
    typeof candidate.lastReviewedCommitSha === "string" &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.draftCommentIds) &&
    (candidate.lastProbeAt === undefined || typeof candidate.lastProbeAt === "string")
  );
}
