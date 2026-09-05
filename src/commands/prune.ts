import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { getIo, writeJson, writeOut } from "../io.js";
import { acquireWriterLock, unlock } from "../lock.js";
import { storeDir } from "../paths.js";
import { pruneStore } from "../store/prune.js";
import { proxyJson } from "./proxy.js";

export async function cmdPrune(root: string, opts: { dryRun?: boolean }): Promise<void> {
  if (!existsSync(storeDir(root))) {
    throw new CliError("E_NOT_A_PROJECT", "no .localhosting store");
  }
  const lock = await acquireWriterLock(root);
  try {
    if (lock.mode === "proxy") {
      const r = await proxyJson(lock.dashboard, "/api/prune", { dryRun: !!opts.dryRun });
      if (getIo().json) writeJson(r);
      else writeOut((r.deleteIds as string[]).join("\n"));
      return;
    }
    const config = await loadConfig(root);
    const r = await pruneStore(root, config, { dryRun: !!opts.dryRun });
    if (r.overCap) {
      const { writeErr } = await import("../io.js");
      writeErr("localhosting: E_STORE_OVER_CAP store still over maxStoreMb after prune");
    }
    if (getIo().json) writeJson({ ok: true, deleteIds: r.deleteIds, overCap: r.overCap });
    else {
      if (r.deleteIds.length === 0) writeOut("(none)");
      else for (const id of r.deleteIds) writeOut(id);
    }
  } finally {
    if (lock.mode === "local") await unlock(root);
  }
}
