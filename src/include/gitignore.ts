import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ignore } from "ignore";
import { ignore } from "./ignore-fn.js";

export async function readIgnoreFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

export function compileIgnore(text: string | null): Ignore {
  const ig = ignore();
  if (text) ig.add(text);
  return ig;
}

export async function loadRootIgnore(root: string, name: string): Promise<Ignore> {
  const text = await readIgnoreFile(join(root, name));
  return compileIgnore(text);
}

export function ignores(ig: Ignore, relPosix: string): boolean {
  if (!relPosix || relPosix === ".") return false;
  return ig.ignores(relPosix);
}
