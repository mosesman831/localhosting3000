import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Ignore } from "ignore";
import { ignore } from "./ignore-fn.js";
import { DEFAULT_EXTRA_IGNORE, DENYLIST_PATTERNS, denylistEnabled } from "./denylist.js";
import { compileIgnore, loadRootIgnore, readIgnoreFile } from "./gitignore.js";
import { isEnvProtectBasename } from "./protect.js";
import { isInsideRoot, toPosix } from "../paths.js";
import type { ConfigV1, ManifestFile, SkippedFile } from "../types.js";

export interface WalkResult {
  files: ManifestFile[];
  skipped: SkippedFile[];
  skipped_truncated: boolean;
}

const SKIP_CAP = 100;

function fileMode(stats: { mode: number }): number {
  if (process.platform === "win32") {
    const exec = (stats.mode & 0o111) !== 0;
    return exec ? 0o100755 : 0o100644;
  }
  return stats.mode;
}

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function computeTreeHash(files: ManifestFile[]): string {
  const sorted = [...files].sort((a, b) => {
    const ba = Buffer.from(a.path, "utf8");
    const bb = Buffer.from(b.path, "utf8");
    return Buffer.compare(ba, bb);
  });
  let out = "";
  for (const f of sorted) {
    out +=
      f.path +
      "\t" +
      f.type +
      "\t" +
      (f.sha256 ?? "") +
      "\t" +
      String(f.mode) +
      "\t" +
      (f.target ?? "") +
      "\n";
  }
  return createHash("sha256").update(out, "utf8").digest("hex");
}

export function isLocalhostingPath(relPosix: string): boolean {
  return relPosix === ".localhosting" || relPosix.startsWith(".localhosting/");
}

export function watchEventIgnored(relPosix: string): boolean {
  if (!relPosix || relPosix === ".") return false;
  if (isLocalhostingPath(relPosix)) return true;
  if (relPosix.endsWith(".tmp")) return true;
  const parts = relPosix.split("/");
  if (parts.includes("node_modules") || parts.includes(".git")) return true;
  const deny = ignore().add(DENYLIST_PATTERNS);
  if (deny.ignores(relPosix)) return true;
  return false;
}

async function nestedGitIgnored(
  root: string,
  relPosix: string,
  cache: Map<string, Ignore>,
): Promise<boolean> {
  const parts = relPosix.split("/");
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const dir = acc;
    const key = dir || ".";
    let ig = cache.get(key);
    if (!ig) {
      const giPath = join(root, dir, ".gitignore");
      const text = await readIgnoreFile(giPath);
      ig = compileIgnore(text);
      cache.set(key, ig);
    }
    const rest = parts.slice(i).join("/");
    if (rest && ig.ignores(rest)) return true;
    if (i < parts.length - 1) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
    }
  }
  return false;
}

export async function walkInclude(root: string, config: ConfigV1): Promise<WalkResult> {
  const deny = ignore().add(denylistEnabled() ? DENYLIST_PATTERNS : []);
  const extra = ignore().add(DEFAULT_EXTRA_IGNORE);
  const lhIgnore = await loadRootIgnore(root, ".localhostingignore");
  const gitCache = new Map<string, Ignore>();
  const files: ManifestFile[] = [];
  const skipped: SkippedFile[] = [];
  let truncated = false;

  const pushSkip = (s: SkippedFile) => {
    if (skipped.length < SKIP_CAP) skipped.push(s);
    else truncated = true;
  };

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    rootReal = resolve(root);
  }

  const maxBytes = config.maxFileMb * 1024 * 1024;

  async function visitDir(relDir: string): Promise<void> {
    const absDir = relDir ? join(root, relDir.split("/").join(sep)) : root;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      pushSkip({
        path: relDir || ".",
        reason: "unreadable",
        size: null,
      });
      return;
    }
    for (const ent of entries) {
      const relPosix = relDir ? `${relDir}/${ent.name}` : ent.name;
      const abs = join(absDir, ent.name);

      if (isLocalhostingPath(relPosix)) {
        continue;
      }

      let lst;
      try {
        lst = await lstat(abs);
      } catch {
        pushSkip({ path: relPosix, reason: "unreadable", size: null });
        continue;
      }

      const denyHit = deny.ignores(relPosix) || (lst.isDirectory() && deny.ignores(relPosix + "/"));
      if (denyHit) {
        pushSkip({ path: relPosix, reason: "denylist", size: lst.isFile() ? lst.size : null });
        continue;
      }

      if (lst.isSymbolicLink()) {
        await handleSymlink(relPosix, abs, lst.size);
        continue;
      }

      if (lst.isDirectory()) {
        await visitDir(relPosix);
        continue;
      }

      if (!lst.isFile()) continue;

      const base = basename(relPosix);
      const protectedEnv = config.includeEnv && isEnvProtectBasename(base);

      if (!protectedEnv && lhIgnore.ignores(relPosix)) {
        pushSkip({ path: relPosix, reason: "localhostingignore", size: lst.size });
        continue;
      }

      if (!protectedEnv && (await nestedGitIgnored(root, relPosix, gitCache))) {
        pushSkip({ path: relPosix, reason: "gitignore", size: lst.size });
        continue;
      }

      if (!protectedEnv && extra.ignores(relPosix)) {
        pushSkip({ path: relPosix, reason: "gitignore", size: lst.size });
        continue;
      }

      if (lst.size > maxBytes) {
        pushSkip({ path: relPosix, reason: "too_large", size: lst.size });
        continue;
      }

      try {
        const buf = await readFile(abs);
        const sha = sha256Bytes(buf);
        files.push({
          path: relPosix,
          type: "file",
          sha256: sha,
          mode: fileMode(lst),
          size: buf.length,
          target: null,
        });
      } catch {
        pushSkip({ path: relPosix, reason: "unreadable", size: lst.size });
      }
    }
  }

  async function handleSymlink(relPosix: string, abs: string, size: number): Promise<void> {
    let targetRaw: string;
    try {
      targetRaw = await readlink(abs);
    } catch {
      pushSkip({ path: relPosix, reason: "unreadable", size });
      return;
    }
    const parent = dirname(abs);
    const resolved = resolve(parent, targetRaw);
    let inside = isInsideRoot(rootReal, resolved);
    try {
      const targetReal = await realpath(resolved);
      inside = isInsideRoot(rootReal, targetReal);
    } catch {
      inside = isInsideRoot(rootReal, resolved);
    }
    if (!inside) {
      pushSkip({ path: relPosix, reason: "symlink_escape", size: null });
      return;
    }

    const base = basename(relPosix);
    const protectedEnv = config.includeEnv && isEnvProtectBasename(base);
    if (!protectedEnv && lhIgnore.ignores(relPosix)) {
      pushSkip({ path: relPosix, reason: "localhostingignore", size: null });
      return;
    }
    if (!protectedEnv && (await nestedGitIgnored(root, relPosix, gitCache))) {
      pushSkip({ path: relPosix, reason: "gitignore", size: null });
      return;
    }

    let mode = 0o120777;
    try {
      const st = await lstat(abs);
      mode = fileMode(st);
    } catch {
      /* keep */
    }
    files.push({
      path: relPosix,
      type: "symlink",
      sha256: null,
      mode,
      size: 0,
      target: toPosix(targetRaw),
    });
  }

  await visitDir("");
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return { files, skipped, skipped_truncated: truncated };
}

export async function pathIsIncluded(
  root: string,
  relPosix: string,
  config: ConfigV1,
): Promise<boolean> {
  if (watchEventIgnored(relPosix)) return false;
  if (isLocalhostingPath(relPosix)) return false;
  const deny = ignore().add(denylistEnabled() ? DENYLIST_PATTERNS : []);
  if (deny.ignores(relPosix)) return false;
  const extra = ignore().add(DEFAULT_EXTRA_IGNORE);
  const lhIgnore = await loadRootIgnore(root, ".localhostingignore");
  const base = basename(relPosix);
  const protectedEnv = config.includeEnv && isEnvProtectBasename(base);
  if (!protectedEnv && lhIgnore.ignores(relPosix)) return false;
  if (!protectedEnv && extra.ignores(relPosix)) return false;
  const gitCache = new Map<string, Ignore>();
  if (!protectedEnv && (await nestedGitIgnored(root, relPosix, gitCache))) return false;
  try {
    const st = await stat(join(root, relPosix.split("/").join(sep)));
    if (st.size > config.maxFileMb * 1024 * 1024) return false;
  } catch {
    return true;
  }
  return true;
}

export { sha256Bytes };
