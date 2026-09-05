import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { CliError } from "../errors.js";
import { walkInclude } from "../include/walk.js";
import { getIo, readLine, writeJson, writeOut } from "../io.js";
import { acquireWriterLock, unlock } from "../lock.js";
import { storeDir } from "../paths.js";
import { dryRunText, restoreSnapshot } from "../restore/restore.js";
import { diffTrees } from "../diff/counts.js";
import { loadManifest, resolveSnapshotId } from "../store/manifest.js";
import { proxyJson } from "./proxy.js";
import { RESTART_HINT } from "../types.js";
import { vibeFor } from "../vibe.js";

export async function cmdRestore(
  root: string,
  id: string | undefined,
  opts: { exact?: boolean; dryRun?: boolean; yes?: boolean },
): Promise<number> {
  if (!id) throw new CliError("E_USAGE", "restore requires <id>");
  if (!existsSync(storeDir(root))) {
    throw new CliError("E_NOT_A_PROJECT", "no .localhosting store");
  }
  if (opts.exact && !opts.dryRun && !opts.yes) {
    throw new CliError("E_USAGE", "--exact requires --yes");
  }

  const config = await loadConfig(root);
  const resolved = await resolveSnapshotId(root, id);
  const target = await loadManifest(root, resolved);
  const current = await walkInclude(root, config);
  const diff = diffTrees(current.files, target.files);
  if (!getIo().json || opts.dryRun) {
    writeOut(dryRunText(target, diff, !!opts.exact));
  }

  if (opts.dryRun) {
    return 0;
  }

  // Vibe layer: a one-liner joke before the confirm prompt. Only emitted in
  // non-JSON mode (machine consumers must not see it). The "Type RESTORE to
  // confirm:" prompt itself is unchanged (TV-04 + TV-30 fixtures rely on it).
  if (!getIo().json && !opts.yes) {
    writeOut(`about to restore #${resolved.replace(/^lh_/, "")}. the agent won't like this. ${vibeFor("restore")}`);
  }

  if (!opts.yes) {
    const answer = await readLine("Type RESTORE to confirm: ");
    if (answer !== "RESTORE") {
      throw new CliError("E_ABORTED", "restore not confirmed");
    }
  }

  const lock = await acquireWriterLock(root);
  try {
    if (lock.mode === "proxy") {
      const r = (await proxyJson(lock.dashboard, "/api/restore", {
        id: resolved,
        confirm: true,
        exact: !!opts.exact,
      })) as { hint?: string; safety_id?: string; locked_failed?: unknown[]; exit_code?: number };
      if (getIo().json) writeJson(r);
      else {
        writeOut(r.hint ?? RESTART_HINT);
      }
      const code = r.exit_code ?? 0;
      if (code === 4) throw new CliError("E_PARTIAL", "some files were locked");
      return code;
    }

    const result = await restoreSnapshot(root, config, resolved, {
      exact: !!opts.exact,
      confirmed: true,
    });
    if (getIo().json) writeJson(result);
    if (result.locked_failed.length > 0) {
      if (!getIo().json) throw new CliError("E_PARTIAL", "some files were locked");
      return 4;
    }
    return 0;
  } finally {
    if (lock.mode === "local") await unlock(root);
  }
}
