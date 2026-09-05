import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export function storeDir(root: string): string {
  return join(root, ".localhosting");
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function posixJoin(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

export function isInsideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

export async function resolveRoot(dir: string): Promise<string> {
  const abs = resolve(dir);
  return await realpath(abs);
}

export function isWindowsDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(p);
}

export async function isForbiddenRoot(root: string): Promise<boolean> {
  let resolved = root;
  try {
    resolved = await realpath(root);
  } catch {
    resolved = resolve(root);
  }
  if (resolved === "/" || resolved === homedir()) return true;
  if (isWindowsDriveRoot(resolved)) return true;
  let home = homedir();
  try {
    home = await realpath(home);
  } catch {
    /* keep */
  }
  return resolved === home;
}
