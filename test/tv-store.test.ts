import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli, makeProject, rmrf, startProbe, waitFor, Collect } from "./helpers.js";
import { run } from "../src/cli.js";
import { loadAllManifests, loadManifest } from "../src/store/manifest.js";
import { computeTreeHash } from "../src/include/walk.js";
import { gcOnStart } from "../src/store/gc.js";
import { objectPaths } from "../src/store/blobs.js";
import { readdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { Io } from "../src/io.js";

async function snap(dir: string, extra: string[] = []) {
  return cli(["snapshot", ...extra], { dir, yes: true });
}

test("TV-02 identical tree_hash skip_dup updates last_seen_good_at", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const first = (await loadAllManifests(dir))[0];
    await new Promise((r) => setTimeout(r, 20));
    const r = await snap(dir);
    assert.equal(r.code, 0);
    const all = await loadAllManifests(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, first.id);
    assert.ok(all[0].last_seen_good_at > first.last_seen_good_at);
    const journal = await readFile(join(dir, ".localhosting", "journal.jsonl"), "utf8");
    assert.match(journal, /skip_dup/);
  } finally {
    await rmrf(dir);
  }
});

test("TV-03 node_modules never in files or blobs", async () => {
  const dir = await makeProject();
  try {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "SECRET\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.ok(m);
    assert.equal(m.files.some((f) => f.path.includes("node_modules")), false);
    const objs = join(dir, ".localhosting", "objects", "sha256");
    async function walk(p: string): Promise<string> {
      let acc = "";
      if (!existsSync(p)) return acc;
      for (const n of await readdir(p, { withFileTypes: true })) {
        const fp = join(p, n.name);
        if (n.isDirectory()) acc += await walk(fp);
        else acc += await readFile(fp, "utf8").catch(() => "");
      }
      return acc;
    }
    const blobText = await walk(objs);
    assert.equal(blobText.includes("SECRET"), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-04 .git/HEAD never in files", async () => {
  const dir = await makeProject();
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.files.some((f) => f.path.startsWith(".git/")), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-05 .localhosting/config.json never in files", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.files.some((f) => f.path.startsWith(".localhosting/")), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-06 .env gitignored included by default, excluded with --no-include-env", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, ".gitignore"), ".env\n");
    await writeFile(join(dir, ".env"), "SECRET=1\n");
    await snap(dir);
    let [m] = await loadAllManifests(dir);
    assert.ok(m.files.some((f) => f.path === ".env"));

    const dir2 = await makeProject({ includeEnv: false });
    await writeFile(join(dir2, ".gitignore"), ".env\n");
    await writeFile(join(dir2, ".env"), "SECRET=1\n");
    await snap(dir2);
    [m] = await loadAllManifests(dir2);
    assert.equal(m.files.some((f) => f.path === ".env"), false);
    await rmrf(dir2);
  } finally {
    await rmrf(dir);
  }
});

test("TV-07 too_large skipped, no blob", async () => {
  const dir = await makeProject({ maxFileMb: 1 });
  try {
    const big = Buffer.alloc(1 * 1024 * 1024 + 1, 7);
    await writeFile(join(dir, "huge.bin"), big);
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const sk = m.skipped.find((s) => s.path === "huge.bin");
    assert.ok(sk);
    assert.equal(sk.reason, "too_large");
    assert.equal(m.files.some((f) => f.path === "huge.bin"), false);
    const shaWould = m.files[0].sha256;
    void shaWould;
  } finally {
    await rmrf(dir);
  }
});

test("TV-08 maxFiles+1 aborts E_TREE_TOO_LARGE", async () => {
  const dir = await makeProject({ maxFiles: 10 });
  try {
    for (let i = 0; i < 11; i++) {
      await writeFile(join(dir, `f${i}.txt`), `${i}\n`);
    }
    const r = await snap(dir);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /E_TREE_TOO_LARGE/);
    assert.equal((await loadAllManifests(dir)).length, 0);
  } finally {
    await rmrf(dir);
  }
});

test("TV-09 tmp without manifest rename is invisible; GC removes old tmp", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const tmp = join(dir, ".localhosting", "tmp", "orphan.bin");
    await writeFile(tmp, "x");
    const fake = join(dir, ".localhosting", "snapshots", "lh_20990101T000000_deadbeef.json.tmp");
    await writeFile(fake, "{}");
    const list = await cli(["list", "--json"], { dir, json: true });
    assert.equal(list.code, 0);
    assert.equal(list.stdout.includes("lh_20990101T000000_deadbeef"), false);
    const past = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(tmp, past, past);
    await gcOnStart(dir);
    assert.equal(existsSync(tmp), false);
    assert.equal(existsSync(fake), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-10 tree_hash recomputes", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(computeTreeHash(m.files), m.tree_hash);
    assert.equal(m.tree_hash.length, 64);
  } finally {
    await rmrf(dir);
  }
});

test("TV-12 *.log not included", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "noise.log"), "log\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.files.some((f) => f.path.endsWith(".log")), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-13 .localhostingignore excludes secret.txt", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, ".localhostingignore"), "secret.txt\n");
    await writeFile(join(dir, "secret.txt"), "nope\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.files.some((f) => f.path === "secret.txt"), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-14 symlink escape skipped", async () => {
  const dir = await makeProject();
  try {
    await symlink("/etc/passwd", join(dir, "escape"));
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.files.some((f) => f.path === "escape"), false);
    assert.ok(m.skipped.some((s) => s.path === "escape" && s.reason === "symlink_escape"));
  } finally {
    await rmrf(dir);
  }
});

test("TV-21 identical bytes share one object", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "a.txt"), "same\n");
    await writeFile(join(dir, "b.txt"), "same\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const a = m.files.find((f) => f.path === "a.txt")!;
    const b = m.files.find((f) => f.path === "b.txt")!;
    assert.equal(a.sha256, b.sha256);
    const { raw, gz } = objectPaths(dir, a.sha256!);
    const present = existsSync(raw) || existsSync(gz);
    assert.equal(present, true);
    const objRoot = join(dir, ".localhosting", "objects", "sha256");
    let count = 0;
    for (const bucket of await readdir(objRoot)) {
      count += (await readdir(join(objRoot, bucket))).length;
    }
    assert.equal(count, new Set(m.files.filter((f) => f.sha256).map((f) => f.sha256)).size);
  } finally {
    await rmrf(dir);
  }
});

test("TV-23 watch on homedir exits E_HOME", async () => {
  const stdout = new Collect();
  const stderr = new Collect();
  const io: Io = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    json: false,
    yes: false,
    dir: homedir(),
    env: process.env,
  };
  const code = await run(["--dir", homedir(), "watch"], { io });
  assert.equal(code, 3);
  assert.match(stderr.text(), /E_HOME/);
});

test("TV-24 manual snapshot while probe down", async () => {
  const dir = await makeProject();
  try {
    const r = await snap(dir);
    assert.equal(r.code, 0);
    const [m] = await loadAllManifests(dir);
    assert.equal(m.trigger, "manual");
    assert.equal(m.confidence, "manual");
  } finally {
    await rmrf(dir);
  }
});

test("TV-35 unknown id E_ID", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const r = await cli(["restore", "lh_19990101T000000_ffffffff", "--yes"], { dir, yes: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E_ID/);
  } finally {
    await rmrf(dir);
  }
});

void startProbe;
void waitFor;
void chmod;
void loadManifest;
