import { mkdir, open, readFile, rename, rm, symlink, unlink, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import { formatAgeAgo, formatLocalDateTime } from "../format.js";
import { walkInclude } from "../include/walk.js";
import { getIo, writeErr, writeOut } from "../io.js";
import { storeDir } from "../paths.js";
import { testHooks } from "../test-hooks.js";
import { diffTrees, formatPathList } from "../diff/counts.js";
import { readAndVerifyBlob, writeFileFsync } from "../store/blobs.js";
import { commitSnapshot } from "../store/commit.js";
import { gcUnreferencedObjects } from "../store/gc.js";
import { appendJournal } from "../store/journal.js";
import { loadManifest, resolveSnapshotId } from "../store/manifest.js";
import { pruneStore } from "../store/prune.js";
import type { ConfigV1, ManifestV1, RestoreJournal, RestoreResponse } from "../types.js";
import { RESTART_HINT } from "../types.js";
import { toRfc3339Z } from "../ids.js";

const RETRIES = 3;
const RETRY_MS = 100;

export interface RestoreOpts {
  exact?: boolean;
  dryRun?: boolean;
  confirmed?: boolean;
  deferPrune?: boolean;
}

export async function verifyManifestBlobs(root: string, m: ManifestV1): Promise<void> {
  for (const f of m.files) {
    if (f.type === "file" && f.sha256) {
      await readAndVerifyBlob(root, f.sha256);
    }
  }
}

export function dryRunText(
  m: ManifestV1,
  diff: ReturnType<typeof diffTrees>,
  exact: boolean,
): string {
  const age = formatAgeAgo(Date.now() - Date.parse(m.created_at));
  const lines: string[] = [];
  lines.push(`Id: ${m.id}`);
  lines.push(`Taken: ${formatLocalDateTime(m.created_at)} (${age})`);
  lines.push(`Trigger: ${m.trigger}  Confidence: ${m.confidence}`);
  lines.push(
    `This will overwrite ${diff.overwrite.length} files and create ${diff.create.length} files.`,
  );
  if (exact) {
    lines.push(`Files on disk not in this snapshot: ${diff.extra.length} (they will be deleted).`);
  } else {
    lines.push(`Files on disk not in this snapshot: ${diff.extra.length} (they will be kept).`);
  }
  lines.push(
    "A safety snapshot of the current tree is taken first. If this restore is a mistake, restore the new SAFETY row.",
  );
  lines.push("Restart your dev server after restore. localhosting does not stop processes.");
  if (diff.extra.length > 0) {
    lines.push(exact ? "Deletion list:" : "Kept extras:");
    for (const p of formatPathList(diff.extra)) lines.push(`  ${p}`);
  }
  if (diff.overwrite.length > 0) {
    lines.push("Overwrite:");
    for (const p of formatPathList(diff.overwrite)) lines.push(`  ${p}`);
  }
  return lines.join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function applyFile(dest: string, data: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = dest + ".lh-tmp-" + randomBytes(6).toString("hex");
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < RETRIES; i++) {
    try {
      if (testHooks.ebusyPaths.has(dest) || testHooks.ebusyPaths.has(posixOf(dest))) {
        const e = Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        throw e;
      }
      await writeFileFsync(tmp, data);
      await chmod(tmp, mode & 0o777).catch(() => undefined);
      await rename(tmp, dest);
      return;
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException;
      await rm(tmp, { force: true });
      if (lastErr.code === "EBUSY" || lastErr.code === "EPERM" || lastErr.code === "EACCES") {
        await sleep(RETRY_MS);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("apply failed");
}

function posixOf(p: string): string {
  return p.split("\\").join("/");
}

export async function restoreSnapshot(
  root: string,
  config: ConfigV1,
  idSpec: string,
  opts: RestoreOpts,
): Promise<RestoreResponse> {
  const id = await resolveSnapshotId(root, idSpec);
  const target = await loadManifest(root, id);
  try {
    await verifyManifestBlobs(root, target);
  } catch (err) {
    if (err instanceof CliError && err.code === "E_CORRUPT") throw err;
    throw err;
  }

  const currentWalk = await walkInclude(root, config);
  const diff = diffTrees(currentWalk.files, target.files);

  if (opts.dryRun) {
    writeOut(dryRunText(target, diff, !!opts.exact));
    return dummyResponse(id, id, diff, !!opts.exact);
  }

  if (!opts.confirmed) {
    throw new CliError("E_ABORTED", "restore not confirmed");
  }

  let safety;
  try {
    safety = await commitSnapshot({
      root,
      config,
      trigger: "pre_restore",
      confidence: "manual",
      probe_url: null,
      probe_status: null,
      deferPrune: true,
      restoringId: id,
    });
  } catch (err) {
    const msg = err instanceof CliError ? err.message : (err as Error).message;
    throw new CliError("E_SAFETY", msg);
  }

  const journal: RestoreJournal = {
    phase: "applying",
    target: id,
    safety_id: safety.id,
    started_at: toRfc3339Z(),
  };
  const journalPath = join(storeDir(root), "restore-journal.json");
  await writeFileFsync(journalPath, JSON.stringify(journal) + "\n");
  await appendJournal(root, "restore_start", id, { safety_id: safety.id });

  const session = randomBytes(8).toString("hex");
  const staging = join(storeDir(root), "staging", session);
  await mkdir(staging, { recursive: true });

  const locked_failed: Array<{ path: string; code: string }> = [];

  try {
    for (const f of target.files) {
      const dest = join(staging, f.path);
      await mkdir(dirname(dest), { recursive: true });
      if (f.type === "symlink") {
        await symlink(f.target ?? "", dest);
      } else if (f.sha256) {
        const bytes = await readAndVerifyBlob(root, f.sha256);
        await writeFileFsync(dest, bytes);
      }
    }

    for (const p of [...diff.create, ...diff.overwrite]) {
      const f = target.files.find((x) => x.path === p)!;
      const dest = join(root, p);
      try {
        if (f.type === "symlink") {
          await mkdir(dirname(dest), { recursive: true });
          await rm(dest, { force: true });
          await symlink(f.target ?? "", dest);
        } else if (f.sha256) {
          const bytes = await readFile(join(staging, p));
          await applyFile(dest, bytes, f.mode);
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        locked_failed.push({ path: p, code: e.code ?? "E_FAIL" });
      }
    }

    let deleted_exact = 0;
    if (opts.exact) {
      for (const p of diff.extra) {
        try {
          await unlink(join(root, p));
          deleted_exact++;
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          writeErr(`localhosting: skip extra ${p} ${e.code ?? e.message}`);
        }
      }
    }

    journal.phase = "done";
    await rm(journalPath, { force: true });
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(storeDir(root), "staging"), { recursive: true });
    await appendJournal(root, "restore_end", id, {
      safety_id: safety.id,
      locked: locked_failed.length,
    });

    if (!opts.deferPrune) {
      await pruneStore(root, config, { restoringId: null });
      await gcUnreferencedObjects(root);
    }

    if (!getIo().json) writeOut(RESTART_HINT);

    const resp: RestoreResponse = {
      schema: "localhosting.restore.v1",
      ok: locked_failed.length === 0,
      exit_code: locked_failed.length === 0 ? 0 : 4,
      id,
      safety_id: safety.id,
      overwritten: diff.overwrite.length,
      created: diff.create.length,
      kept_extra: opts.exact ? 0 : diff.extra.length,
      deleted_exact,
      locked_failed,
      hint: RESTART_HINT,
    };
    return resp;
  } catch (err) {
    throw err;
  }
}

function dummyResponse(
  id: string,
  safety: string,
  diff: ReturnType<typeof diffTrees>,
  exact: boolean,
): RestoreResponse {
  return {
    schema: "localhosting.restore.v1",
    ok: true,
    exit_code: 0,
    id,
    safety_id: safety,
    overwritten: diff.overwrite.length,
    created: diff.create.length,
    kept_extra: exact ? 0 : diff.extra.length,
    deleted_exact: exact ? diff.extra.length : 0,
    locked_failed: [],
    hint: RESTART_HINT,
  };
}

void open;
