import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A simple lockfile guard that keeps two daemon instances from running against
 * the same state file. The lock holds the owner's PID; a lock left behind by a
 * dead process is detected and taken over automatically.
 */
export class DaemonLock {
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    if (existsSync(this.lockPath)) {
      let pid = NaN;
      try {
        pid = Number(readFileSync(this.lockPath, "utf8").trim());
      } catch {
        pid = NaN;
      }
      if (Number.isFinite(pid) && processIsAlive(pid)) {
        throw new Error(
          `Another review-agent daemon is already running (pid ${pid}). Refusing to start a second instance against ${this.lockPath}.`,
        );
      }
      // The lock is stale (its process died); take it over.
      rmSync(this.lockPath, { force: true });
    }
    try {
      writeFileSync(this.lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      throw new Error(
        `Could not acquire the daemon lock ${this.lockPath}: another instance may just have started. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  release(): void {
    rmSync(this.lockPath, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}