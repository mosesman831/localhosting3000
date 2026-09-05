import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { pinManifest } from "../dashboard/listen.js";
import { CliError } from "../errors.js";
import { getIo, writeJson, writeOut } from "../io.js";
import { acquireWriterLock, unlock } from "../lock.js";
import { storeDir } from "../paths.js";
import { proxyJson } from "./proxy.js";

export async function cmdPin(
  root: string,
  id: string | undefined,
  opts: { forcePin?: boolean; pinned: boolean },
): Promise<void> {
  if (!id) throw new CliError("E_USAGE", "pin requires <id>");
  if (!existsSync(storeDir(root))) {
    throw new CliError("E_NOT_A_PROJECT", "no .localhosting store");
  }
  const lock = await acquireWriterLock(root);
  try {
    if (lock.mode === "proxy") {
      const r = await proxyJson(lock.dashboard, "/api/pin", { id, pinned: opts.pinned });
      if (getIo().json) writeJson(r);
      else writeOut(`${opts.pinned ? "pinned" : "unpinned"} ${id}`);
      return;
    }
    const config = await loadConfig(root);
    const m = await pinManifest(root, id, opts.pinned, config, !!opts.forcePin);
    if (getIo().json) writeJson({ ok: true, id: m.id, pinned: m.pinned });
    else writeOut(`${m.pinned ? "pinned" : "unpinned"} ${m.id}`);
  } finally {
    if (lock.mode === "local") await unlock(root);
  }
}
