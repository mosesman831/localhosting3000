import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import { newSnapshotId, toRfc3339Z } from "../ids.js";
import { computeTreeHash, walkInclude } from "../include/walk.js";
import { writeErr } from "../io.js";
import { isForbiddenRoot, storeDir } from "../paths.js";
import { testHooks } from "../test-hooks.js";
import type { Confidence, ConfigV1, ManifestV1, Trigger } from "../types.js";
import { writeBlob } from "./blobs.js";
import { gcUnreferencedObjects } from "./gc.js";
import { appendJournal } from "./journal.js";
import { latestManifest, writeManifestAtomic } from "./manifest.js";
import { pruneStore } from "./prune.js";

export interface CommitInput {
  root: string;
  config: ConfigV1;
  trigger: Trigger;
  confidence: Confidence;
  probe_url: string | null;
  probe_status: number | null;
  pinned?: boolean;
  deferPrune?: boolean;
  restoringId?: string | null;
}

export interface CommitResult {
  id: string;
  skipDup: boolean;
  manifest: ManifestV1;
}

export async function commitSnapshot(input: CommitInput): Promise<CommitResult> {
  const { root, config, trigger, confidence } = input;
  if (await isForbiddenRoot(root)) {
    throw new CliError("E_HOME", "refusing to snapshot / , a drive root, or $HOME");
  }
  if (testHooks.failNextSnapshot) {
    testHooks.failNextSnapshot = false;
    throw new CliError("E_DISK", "injected snapshot write failure");
  }

  const walked = await walkInclude(root, config);
  if (walked.files.length === 0) {
    throw new CliError("E_EMPTY_TREE", "nothing to snapshot");
  }
  if (walked.files.length > config.maxFiles) {
    throw new CliError("E_TREE_TOO_LARGE", `included file count ${walked.files.length} exceeds maxFiles`);
  }

  const tree_hash = computeTreeHash(walked.files);
  const latest = await latestManifest(root);
  const now = toRfc3339Z();

  if (latest && latest.tree_hash === tree_hash) {
    latest.last_seen_good_at = now;
    await writeManifestAtomic(root, latest);
    await appendJournal(root, "skip_dup", latest.id, { tree_hash });
    return { id: latest.id, skipDup: true, manifest: latest };
  }

  const id = newSnapshotId();
  const shaSeen = new Set<string>();
  try {
    for (const f of walked.files) {
      if (f.type !== "file" || !f.sha256) continue;
      if (shaSeen.has(f.sha256)) continue;
      shaSeen.add(f.sha256);
      const abs = join(root, f.path);
      const bytes = await readFile(abs);
      await writeBlob(root, id, f.sha256, bytes);
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    const e = err as NodeJS.ErrnoException;
    throw new CliError("E_DISK", e.message || "CAS write failed");
  }

  const total_size = walked.files.reduce((n, f) => n + f.size, 0);
  const manifest: ManifestV1 = {
    schema: "localhosting.snapshot.v1",
    id,
    created_at: now,
    last_seen_good_at: now,
    trigger,
    confidence,
    pinned: input.pinned ?? false,
    root,
    probe_url: input.probe_url,
    probe_status: input.probe_status,
    file_count: walked.files.length,
    total_size,
    tree_hash,
    parent_id: latest?.id ?? null,
    files: walked.files,
    skipped: walked.skipped,
    skipped_truncated: walked.skipped_truncated,
  };

  await writeManifestAtomic(root, manifest);
  await appendJournal(root, "commit", id, { trigger, file_count: walked.files.length });

  if (!input.deferPrune) {
    const pruned = await pruneStore(root, config, { restoringId: input.restoringId ?? null });
    if (pruned.overCap) {
      writeErr("localhosting: E_STORE_OVER_CAP store still over maxStoreMb after prune");
    }
    await gcUnreferencedObjects(root);
  }

  void storeDir;
  return { id, skipDup: false, manifest };
}
