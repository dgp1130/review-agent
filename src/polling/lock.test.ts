import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonLock } from "./lock.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ra-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DaemonLock", () => {
  it("creates a lock file holding the current pid", () => {
    const path = join(tempDir(), "state.json.lock");
    const lock = new DaemonLock(path);
    lock.acquire();
    expect(Number(readFileSync(path, "utf8").trim())).toBe(process.pid);
  });

  it("refuses when the lock is held by a live process", () => {
    const path = join(tempDir(), "state.json.lock");
    const first = new DaemonLock(path);
    first.acquire();
    const second = new DaemonLock(path);
    expect(() => second.acquire()).toThrow(/already running/);
  });

  it("takes over a stale lock left by a dead process", () => {
    const path = join(tempDir(), "state.json.lock");
    writeFileSync(path, "999999999\n", "utf8");
    const lock = new DaemonLock(path);
    lock.acquire();
    expect(Number(readFileSync(path, "utf8").trim())).toBe(process.pid);
  });

  it("releases the lock and allows a new acquisition", () => {
    const path = join(tempDir(), "state.json.lock");
    const lock = new DaemonLock(path);
    lock.acquire();
    lock.release();
    expect(() => new DaemonLock(path).acquire()).not.toThrow();
  });
});