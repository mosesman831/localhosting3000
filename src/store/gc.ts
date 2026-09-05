import { Dirent } from "node:fs";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { storeDir } from "../paths.js";
import { loadAllManifests } from "./manifest.js";
import { objectPaths } from "./blobs.js";

export async function gcOnStart(root: string): Promise<void> {
  const snapDir = join(storeDir(root), "snapshots");
  const tmpDir = join(storeDir(root), "tmp");
  await gcTmpNamed(snapDir, true, 0);
  await gcTmpNamed(tmpDir, false, 10 * 60 * 1000);
}

async function gcTmpNamed(dir: string, snapshotsTmp: boolean, minAgeMs: number): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (snapshotsTmp) {
      if (!name.endsWith(".json.tmp")) continue;
    }
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) continue;
      await rm(p, { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
}

export async function gcUnreferencedObjects(root: string): Promise<void> {
  const manifests = await loadAllManifests(root);
  const live = new Set<string>();
  for (const m of manifests) {
    for (const f of m.files) {
      if (f.sha256) live.add(f.sha256);
    }
  }
  const objRoot = join(storeDir(root), "objects", "sha256");
  let buckets: string[] = [];
  try {
    buckets = await readdir(objRoot);
  } catch {
    return;
  }
  for (const b of buckets) {
    const dir = join(objRoot, b);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      const rest = name.endsWith(".gz") ? name.slice(0, -3) : name;
      const sha = b + rest;
      if (!live.has(sha)) {
        await rm(join(dir, name), { force: true });
      }
    }
  }
}

export async function bytesOnDisk(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let names: Dirent[] = [];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else {
        try {
          const st = await stat(p);
          total += st.size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(join(storeDir(root), "objects"));
  await walk(join(storeDir(root), "snapshots"));
  return total;
}

void utimes;
void objectPaths;
