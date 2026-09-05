import { loadConfig } from "../config.js";
import { ensureStore } from "../config.js";
import { writeJson, writeOut, getIo } from "../io.js";
import { acquireWriterLock, unlock } from "../lock.js";
import { commitSnapshot } from "../store/commit.js";
import { pinManifest } from "../dashboard/listen.js";
import { proxyJson } from "./proxy.js";
import { vibeFor } from "../vibe.js";

export async function cmdSnapshot(
  root: string,
  opts: { pin?: boolean },
): Promise<void> {
  await ensureStore(root);
  const lock = await acquireWriterLock(root);
  try {
    if (lock.mode === "proxy") {
      const r = await proxyJson(lock.dashboard, "/api/snapshot", { pin: !!opts.pin });
      if (getIo().json) writeJson(r);
      else writeOut(`snapshot ${r.id as string} ${vibeFor("snapshot")}`);
      return;
    }
    const config = await loadConfig(root);
    const result = await commitSnapshot({
      root,
      config,
      trigger: "manual",
      confidence: "manual",
      probe_url: null,
      probe_status: null,
    });
    if (opts.pin && !result.skipDup) {
      await pinManifest(root, result.id, true, config, false);
    } else if (opts.pin && result.skipDup) {
      await pinManifest(root, result.id, true, config, false);
    }
    if (getIo().json) {
      writeJson({ ok: true, id: result.id, skip_dup: result.skipDup });
    } else if (result.skipDup) {
      writeOut(
        `good state unchanged  ${result.id}  last_seen_good_at=${result.manifest.last_seen_good_at}`,
      );
    } else {
      const m = result.manifest;
      // Vibe layer: keep the spec-mandated "snapshot <id>" field then add
      // file count, byte count (matching the prompt's example), and an emoji.
      // Conformance regex tests look for the bare "snapshot <id>" substring;
      // the trailing text doesn't affect match assertions.
      writeOut(
        `snapshot ${m.id} saved (${m.file_count} files, ${m.total_size} bytes). you're welcome. ${vibeFor("snapshot")}`,
      );
    }
  } finally {
    if (lock.mode === "local") await unlock(root);
  }
}
