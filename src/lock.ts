import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { toRfc3339Z } from "./ids.js";
import { writeErr } from "./io.js";
import { storeDir } from "./paths.js";
import type { LockFile } from "./types.js";

export function lockPath(root: string): string {
  return join(storeDir(root), "LOCK");
}

export async function readLock(root: string): Promise<LockFile | null> {
  try {
    const text = await readFile(lockPath(root), "utf8");
    return JSON.parse(text) as LockFile;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function writeLock(root: string, dashboard: string): Promise<LockFile> {
  const lock: LockFile = {
    pid: process.pid,
    started_at: toRfc3339Z(),
    dashboard,
  };
  await writeFile(lockPath(root), JSON.stringify(lock) + "\n", "utf8");
  return lock;
}

export async function unlock(root: string): Promise<void> {
  const cur = await readLock(root);
  if (cur && cur.pid === process.pid) {
    await rm(lockPath(root), { force: true });
  }
}

export async function dashboardReachable(dashboard: string, timeoutMs = 2000): Promise<boolean> {
  if (!dashboard || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(dashboard)) {
    return false;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/api/status", dashboard.endsWith("/") ? dashboard : dashboard + "/").href, {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export type LockMode = { mode: "local" } | { mode: "proxy"; dashboard: string };

export async function acquireWatchLock(root: string): Promise<void> {
  const existing = await readLock(root);
  if (existing) {
    const alive = pidAlive(existing.pid);
    const self = existing.pid === process.pid;
    if (alive && !self) {
      throw new CliError("E_LOCKED", "watch is already running");
    }
    if (alive && self && existing.dashboard && (await dashboardReachable(existing.dashboard))) {
      throw new CliError("E_LOCKED", "watch is already running");
    }
    if (!alive) {
      writeErr(`localhosting: stealing stale lock (pid ${existing.pid} dead)`);
      await sleep(2000);
      const again = await readLock(root);
      if (again && pidAlive(again.pid) && again.pid !== process.pid) {
        throw new CliError("E_LOCKED", "watch is already running");
      }
    }
  }
  await writeLock(root, "");
}

export async function acquireWriterLock(root: string): Promise<LockMode> {
  const existing = await readLock(root);
  if (!existing) {
    await writeLock(root, "");
    return { mode: "local" };
  }
  const alive = pidAlive(existing.pid);
  const self = existing.pid === process.pid;
  if (alive) {
    if (existing.dashboard && (await dashboardReachable(existing.dashboard))) {
      return { mode: "proxy", dashboard: existing.dashboard };
    }
    if (existing.dashboard || !self) {
      throw new CliError(
        "E_LOCKED",
        "watch is running but dashboard is not reachable; Ctrl-C the watch process.",
      );
    }
    await writeLock(root, "");
    return { mode: "local" };
  }
  writeErr(`localhosting: stealing stale lock (pid ${existing.pid} dead)`);
  await sleep(2000);
  const again = await readLock(root);
  if (again && pidAlive(again.pid)) {
    if (again.dashboard && (await dashboardReachable(again.dashboard))) {
      return { mode: "proxy", dashboard: again.dashboard };
    }
    throw new CliError("E_LOCKED", "watch is running but dashboard is not reachable; Ctrl-C the watch process.");
  }
  await writeLock(root, "");
  return { mode: "local" };
}
