import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { CliError } from "../errors.js";
import { storeDir } from "../paths.js";
import { testHooks } from "../test-hooks.js";

export function objectPaths(root: string, sha256: string): { dir: string; raw: string; gz: string } {
  const dir = join(storeDir(root), "objects", "sha256", sha256.slice(0, 2));
  const rest = sha256.slice(2);
  return {
    dir,
    raw: join(dir, rest),
    gz: join(dir, rest + ".gz"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fsyncWriteFile(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeBlob(
  root: string,
  snapshotId: string,
  sha256: string,
  bytes: Buffer,
): Promise<void> {
  if (testHooks.failNextSnapshot) {
    const err =
      testHooks.failNextSnapshot === true
        ? Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
        : testHooks.failNextSnapshot;
    testHooks.failNextSnapshot = false;
    throw err;
  }
  const { dir, raw, gz } = objectPaths(root, sha256);
  if ((await exists(raw)) || (await exists(gz))) return;

  const compressed = gzipSync(bytes, { level: 6 });
  const useGz = compressed.length < bytes.length;
  const dest = useGz ? gz : raw;
  const data = useGz ? compressed : bytes;
  const tmpDir = join(storeDir(root), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${snapshotId}-${sha256}.bin`);
  try {
    await fsyncWriteFile(tmp, data);
    await mkdir(dir, { recursive: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOSPC") throw new CliError("E_DISK", "disk full while writing blob");
    throw new CliError("E_DISK", e.message || "blob write failed");
  }
}

export async function readAndVerifyBlob(root: string, sha256: string): Promise<Buffer> {
  const { raw, gz } = objectPaths(root, sha256);
  let buf: Buffer;
  let wasGz = false;
  try {
    buf = await readFile(gz);
    wasGz = true;
  } catch {
    try {
      buf = await readFile(raw);
    } catch {
      throw new CliError("E_CORRUPT", `missing blob ${sha256}`);
    }
  }
  let uncompressed: Buffer;
  try {
    uncompressed = wasGz ? gunzipSync(buf) : buf;
  } catch {
    throw new CliError("E_CORRUPT", `blob ${sha256} is not valid gzip`);
  }
  const got = createHash("sha256").update(uncompressed).digest("hex");
  if (got !== sha256) {
    throw new CliError("E_CORRUPT", `blob ${sha256} hash mismatch`);
  }
  return uncompressed;
}

export async function blobExists(root: string, sha256: string): Promise<boolean> {
  const { raw, gz } = objectPaths(root, sha256);
  return (await exists(raw)) || (await exists(gz));
}

export async function fsyncRename(tmp: string, dest: string): Promise<void> {
  const fh = await open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await mkdir(dirname(dest), { recursive: true });
  await rename(tmp, dest);
}

export async function writeFileFsync(path: string, data: string | Buffer): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  await fsyncWriteFile(path, buf);
}

/** unused helper kept so gzip streaming is available if needed */
export async function gzipToFile(bytes: Buffer, dest: string): Promise<void> {
  const gz = gzipSync(bytes, { level: 6 });
  await fsyncWriteFile(dest, gz);
  void pipeline;
  void Readable;
  void createWriteStream;
}
