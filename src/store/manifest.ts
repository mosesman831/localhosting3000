import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import { storeDir } from "../paths.js";
import { writeFileFsync } from "./blobs.js";
import type { ManifestV1 } from "../types.js";

export function snapshotsDir(root: string): string {
  return join(storeDir(root), "snapshots");
}

export function manifestPath(root: string, id: string): string {
  return join(snapshotsDir(root), `${id}.json`);
}

export async function loadManifest(root: string, id: string): Promise<ManifestV1> {
  try {
    const text = await readFile(manifestPath(root, id), "utf8");
    return JSON.parse(text) as ManifestV1;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new CliError("E_ID", `unknown snapshot id ${id}`);
    throw err;
  }
}

export async function listManifestIds(root: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await readdir(snapshotsDir(root));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"))
    .map((n) => n.slice(0, -".json".length));
}

export async function loadAllManifests(root: string): Promise<ManifestV1[]> {
  const ids = await listManifestIds(root);
  const out: ManifestV1[] = [];
  for (const id of ids) {
    try {
      out.push(await loadManifest(root, id));
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return out;
}

export function sortNewestFirst(manifests: ManifestV1[]): ManifestV1[] {
  return [...manifests].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

export async function latestManifest(root: string): Promise<ManifestV1 | null> {
  const all = await loadAllManifests(root);
  return all[0] ?? null;
}

export async function writeManifestAtomic(root: string, manifest: ManifestV1): Promise<void> {
  const dest = manifestPath(root, manifest.id);
  const tmp = dest + ".tmp";
  await writeFileFsync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(tmp, dest);
}

export async function saveManifest(root: string, manifest: ManifestV1): Promise<void> {
  const dest = manifestPath(root, manifest.id);
  const tmp = dest + ".tmp";
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await rename(tmp, dest);
}

export async function deleteManifest(root: string, id: string): Promise<void> {
  await rm(manifestPath(root, id), { force: true });
}

export async function resolveSnapshotId(root: string, spec: string): Promise<string> {
  if (spec.length < 8) {
    throw new CliError("E_ID", "snapshot id prefix must be at least 8 characters");
  }
  const ids = await listManifestIds(root);
  if (ids.includes(spec)) return spec;
  const matches = ids.filter((id) => id.startsWith(spec));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CliError("E_ID", `unknown snapshot id ${spec}`);
  throw new CliError("E_ID", `ambiguous snapshot id prefix ${spec}`);
}
