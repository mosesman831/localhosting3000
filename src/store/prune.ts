import type { ConfigV1, ManifestV1 } from "../types.js";
import { bytesOnDisk, gcUnreferencedObjects } from "./gc.js";
import { appendJournal } from "./journal.js";
import { deleteManifest, loadAllManifests, sortNewestFirst } from "./manifest.js";

export interface PruneOptions {
  restoringId?: string | null;
  now?: Date;
  dryRun?: boolean;
}

export interface PruneResult {
  deleteIds: string[];
  keptIds: string[];
  overCap: boolean;
}

function utcHourKey(iso: string): string {
  return iso.slice(0, 13);
}

export function selectKeepIds(
  manifests: ManifestV1[],
  config: ConfigV1,
  opts: { restoringId?: string | null; now?: Date } = {},
): Set<string> {
  const keep = new Set<string>();
  if (manifests.length === 0) return keep;
  const newestFirst = sortNewestFirst(manifests);
  const newest = newestFirst[0];
  keep.add(newest.id);
  for (const m of manifests) {
    if (m.pinned) keep.add(m.id);
  }
  const overlay = newestFirst.find((m) => m.confidence === "overlay_clean");
  if (overlay) keep.add(overlay.id);
  if (opts.restoringId) keep.add(opts.restoringId);

  const unpinnedGood = newestFirst.filter(
    (m) => !m.pinned && (m.trigger === "good_build" || m.trigger === "manual"),
  );
  for (const m of unpinnedGood.slice(0, config.keepRecent)) {
    keep.add(m.id);
  }

  const remainder = newestFirst.filter((m) => !keep.has(m.id));
  const now = opts.now ?? new Date();
  const windowMs = config.keepHourlyHours * 3600 * 1000;
  if (config.keepHourly > 0) {
    const byHour = new Map<string, ManifestV1[]>();
    for (const m of remainder) {
      const created = Date.parse(m.created_at);
      if (now.getTime() - created > windowMs) continue;
      const key = utcHourKey(m.created_at);
      const arr = byHour.get(key) ?? [];
      arr.push(m);
      byHour.set(key, arr);
    }
    const hourKeys = [...byHour.keys()].sort().reverse();
    let landmarks = 0;
    for (const key of hourKeys) {
      if (landmarks >= config.keepHourly) break;
      const group = byHour.get(key)!;
      group.sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });
      keep.add(group[0].id);
      landmarks++;
    }
  }

  const safeties = newestFirst.filter((m) => m.trigger === "pre_restore");
  let safetyKept = safeties.filter((m) => keep.has(m.id)).length;
  for (const m of safeties) {
    if (keep.has(m.id)) continue;
    if (safetyKept >= config.keepSafety) break;
    keep.add(m.id);
    safetyKept++;
  }

  return keep;
}

export async function pruneStore(
  root: string,
  config: ConfigV1,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const manifests = await loadAllManifests(root);
  const keep = selectKeepIds(manifests, config, {
    restoringId: opts.restoringId,
    now: opts.now,
  });
  let deleteIds = manifests.filter((m) => !keep.has(m.id)).map((m) => m.id);
  deleteIds.sort();

  if (!opts.dryRun) {
    for (const id of deleteIds) {
      await deleteManifest(root, id);
      await appendJournal(root, "prune", id, {});
    }
    await gcUnreferencedObjects(root);
  }

  const cap = config.maxStoreMb * 1024 * 1024;
  let overCap = false;
  if (!opts.dryRun) {
    const protectedIds = protectedSet(manifests, opts.restoringId);
    let remaining = (await loadAllManifests(root)).slice();
    let bytes = await bytesOnDisk(root);
    while (bytes > cap) {
      const oldestDeletable = [...remaining]
        .filter((m) => !protectedIds.has(m.id))
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        })[0];
      if (!oldestDeletable) {
        overCap = true;
        break;
      }
      await deleteManifest(root, oldestDeletable.id);
      await appendJournal(root, "prune", oldestDeletable.id, { reason: "size_cap" });
      deleteIds.push(oldestDeletable.id);
      remaining = remaining.filter((m) => m.id !== oldestDeletable.id);
      await gcUnreferencedObjects(root);
      bytes = await bytesOnDisk(root);
    }
    if (bytes > cap) overCap = true;
  } else {
    const bytes = await bytesOnDisk(root);
    if (bytes > cap) {
      const protectedIds = protectedSet(manifests, opts.restoringId);
      const extra = [...manifests]
        .filter((m) => !protectedIds.has(m.id) && !deleteIds.includes(m.id))
        .sort((a, b) => {
          if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
          return a.id < b.id ? -1 : 1;
        });
      let simulated = bytes;
      const avg = manifests.length ? bytes / manifests.length : 0;
      for (const m of extra) {
        if (simulated <= cap) break;
        deleteIds.push(m.id);
        simulated -= avg;
      }
    }
  }

  const keptIds = (await loadAllManifests(root)).map((m) => m.id);
  return { deleteIds: [...new Set(deleteIds)], keptIds, overCap };
}

function protectedSet(manifests: ManifestV1[], restoringId?: string | null): Set<string> {
  const keep = new Set<string>();
  const newestFirst = sortNewestFirst(manifests);
  if (newestFirst[0]) keep.add(newestFirst[0].id);
  for (const m of manifests) if (m.pinned) keep.add(m.id);
  const overlay = newestFirst.find((m) => m.confidence === "overlay_clean");
  if (overlay) keep.add(overlay.id);
  if (restoringId) keep.add(restoringId);
  return keep;
}
