import type { ManifestFile } from "../types.js";

export interface TreeDiff {
  overwrite: string[];
  create: string[];
  extra: string[];
}

export function fileKey(f: ManifestFile): string {
  return `${f.type}:${f.sha256 ?? ""}:${f.mode}:${f.target ?? ""}`;
}

export function diffTrees(
  current: ManifestFile[],
  target: ManifestFile[],
): TreeDiff {
  const curMap = new Map(current.map((f) => [f.path, f]));
  const tgtMap = new Map(target.map((f) => [f.path, f]));
  const overwrite: string[] = [];
  const create: string[] = [];
  const extra: string[] = [];
  for (const [p, f] of tgtMap) {
    const c = curMap.get(p);
    if (!c) create.push(p);
    else if (fileKey(c) !== fileKey(f)) overwrite.push(p);
  }
  for (const p of curMap.keys()) {
    if (!tgtMap.has(p)) extra.push(p);
  }
  overwrite.sort();
  create.sort();
  extra.sort();
  return { overwrite, create, extra };
}

export function countsFromDiff(d: TreeDiff): {
  overwrite: number;
  create: number;
  extra: number;
} {
  return { overwrite: d.overwrite.length, create: d.create.length, extra: d.extra.length };
}

export function neighborDelta(
  newer: ManifestFile[],
  older: ManifestFile[],
): { added: number; changed: number; removed: number } {
  const d = diffTrees(older, newer);
  return { added: d.create.length, changed: d.overwrite.length, removed: d.extra.length };
}

export function formatPathList(paths: string[], limit = 50): string[] {
  if (paths.length <= limit) return paths;
  return [...paths.slice(0, limit), `and ${paths.length - limit} more`];
}
