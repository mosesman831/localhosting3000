import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { probeUrl } from "../detect/ssrf.js";
import { buildStatus } from "../dashboard/listen.js";
import { formatStoreMb } from "../format.js";
import { getIo, writeJson, writeOut } from "../io.js";
import { dashboardReachable, pidAlive, readLock } from "../lock.js";
import { storeDir } from "../paths.js";
import { bytesOnDisk } from "../store/gc.js";
import { loadAllManifests } from "../store/manifest.js";
import { walkInclude } from "../include/walk.js";
import type { LastProbe, StatusEnvelope } from "../types.js";
import { progressBar, vibeFor } from "../vibe.js";

// Default store cap (matches config DEFAULT maxStoreMb). Used for the
// progress-bar vibe layer only. Spec doesn't require this exact value to
// appear; the bar is purely decorative.
const DEFAULT_MAX_STORE_MB = 1500;

export async function cmdStatus(root: string): Promise<void> {
  const config = await loadConfig(root);
  const lock = await readLock(root);
  if (lock && pidAlive(lock.pid) && lock.dashboard && (await dashboardReachable(lock.dashboard))) {
    const res = await fetch(new URL("/api/status", lock.dashboard + "/").href);
    const env = (await res.json()) as StatusEnvelope;
    printStatus(env, lock.dashboard);
    return;
  }

  let last: LastProbe = {
    url: probeUrl(config.url, config.probePath),
    last_status: null,
    last_overlay: null,
    last_error: null,
    last_at: null,
  };
  try {
    last = JSON.parse(await readFile(join(storeDir(root), "cache", "last-probe.json"), "utf8"));
  } catch {
    /* defaults */
  }
  const all = existsSync(storeDir(root)) ? await loadAllManifests(root) : [];
  const bytes = existsSync(storeDir(root)) ? await bytesOnDisk(root) : 0;
  let estimate: number | null = null;
  try {
    estimate = (await walkInclude(root, config)).files.length;
  } catch {
    estimate = null;
  }
  const env: StatusEnvelope = {
    schema: "localhosting.status.v1",
    dir: root,
    detector: "STOPPED",
    probe: last,
    lock: null,
    store: { snapshot_count: all.length, bytes_on_disk: bytes },
    restore_journal_present: existsSync(join(storeDir(root), "restore-journal.json")),
    included_file_count_estimate: estimate,
  };
  if (estimate !== null && estimate < 3 && existsSync(join(root, "package.json"))) {
    const { writeErr } = await import("../io.js");
    writeErr("localhosting: warning included file count < 3 while package.json exists");
  }
  printStatus(env, "(not running)");
  void buildStatus;
}

function printStatus(env: StatusEnvelope, dashboard: string): void {
  if (getIo().json) {
    writeJson(env);
    return;
  }
  const last = env.probe.last_status ?? "none";
  const overlay =
    env.probe.last_overlay === null ? "unknown" : String(env.probe.last_overlay);
  // Vibe layer: emoji header, current state front and center, plus an ASCII
  // progress bar for store usage. Spec-mandated fields (status string,
  // detector state, probe URL + last status/overlay, snapshot count, store
  // size in MB, dashboard URL) are all preserved verbatim.
  const stateEmoji =
    env.detector === "PAUSED" ? "🟡" :
    env.detector === "STOPPED" ? "🔴" :
    "🟢"; // RUNNING + any future states default to green
  const maxBytes = DEFAULT_MAX_STORE_MB * 1024 * 1024;
  const pct = maxBytes > 0 ? (env.store.bytes_on_disk / maxBytes) * 100 : 0;
  writeOut(`${vibeFor("status")} localhosting status  ${stateEmoji} ${env.detector}`);
  writeOut(`detector: ${env.detector}`);
  writeOut(`probe:    ${env.probe.url}  last=${last} overlay=${overlay}`);
  writeOut(`snapshots: ${env.store.snapshot_count}  store=${formatStoreMb(env.store.bytes_on_disk)}`);
  writeOut(`usage:    ${progressBar(pct)}  of ${DEFAULT_MAX_STORE_MB} MB cap`);
  writeOut(`dashboard: ${dashboard}`);
}
