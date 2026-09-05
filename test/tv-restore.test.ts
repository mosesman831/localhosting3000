import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { cli, makeProject, rmrf, Collect } from "./helpers.js";
import { loadAllManifests } from "../src/store/manifest.js";
import { objectPaths } from "../src/store/blobs.js";
import { testHooks, resetTestHooks } from "../src/test-hooks.js";
import { run } from "../src/cli.js";
import type { Io } from "../src/io.js";
import { writeLock } from "../src/lock.js";
import { readdir } from "node:fs/promises";

async function snap(dir: string) {
  return cli(["snapshot"], { dir, yes: true });
}

test("TV-11 corrupt blob restore exits E_CORRUPT, no safety, tree unchanged", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "tracked.txt"), "good\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const f = m.files.find((x) => x.path === "tracked.txt")!;
    const { raw, gz } = objectPaths(dir, f.sha256!);
    const p = existsSync(gz) ? gz : raw;
    await writeFile(p, Buffer.from("tampered-bytes-not-matching-hash"));
    await writeFile(join(dir, "tracked.txt"), "changed-on-disk\n");
    const before = (await loadAllManifests(dir)).length;
    const r = await cli(["restore", m.id, "--yes"], { dir, yes: true });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /E_CORRUPT/);
    assert.equal((await loadAllManifests(dir)).length, before);
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "changed-on-disk\n");
  } finally {
    await rmrf(dir);
  }
});

test("TV-25 restore takes pre_restore safety before overwrite", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "tracked.txt"), "A\n");
    await snap(dir);
    const [first] = await loadAllManifests(dir);
    await writeFile(join(dir, "tracked.txt"), "B-dirty\n");
    const r = await cli(["restore", first.id, "--yes"], { dir, yes: true });
    assert.equal(r.code, 0);
    const all = await loadAllManifests(dir);
    const safety = all.find((m) => m.trigger === "pre_restore");
    assert.ok(safety);
    assert.notEqual(safety.id, first.id);
    const destStat = await stat(join(dir, "tracked.txt"));
    assert.ok(Date.parse(safety.created_at) <= destStat.mtimeMs);
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "A\n");
    assert.match(r.stdout, /Restart your dev server\. localhosting does not stop processes\./);
  } finally {
    await rmrf(dir);
  }
});

test("TV-26 safety fail exits E_SAFETY, files unchanged", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "tracked.txt"), "orig\n");
    await snap(dir);
    const [first] = await loadAllManifests(dir);
    await writeFile(join(dir, "tracked.txt"), "dirty\n");
    testHooks.failNextSnapshot = true;
    const r = await cli(["restore", first.id, "--yes"], { dir, yes: true });
    resetTestHooks();
    assert.equal(r.code, 3);
    assert.match(r.stderr, /E_SAFETY/);
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "dirty\n");
    assert.equal((await loadAllManifests(dir)).filter((m) => m.trigger === "pre_restore").length, 0);
  } finally {
    resetTestHooks();
    await rmrf(dir);
  }
});

test("TV-27 restore without --yes and without RESTORE aborts", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "app.js"), "changed\n");
    const stdin = new PassThrough();
    const stdout = new Collect();
    const stderr = new Collect();
    const io: Io = {
      stdout,
      stderr,
      stdin,
      json: false,
      yes: false,
      dir,
      env: process.env,
    };
    stdin.end("nope\n");
    const code = await run(["--dir", dir, "restore", m.id], { io });
    assert.equal(code, 5);
    assert.match(stderr.text(), /E_ABORTED/);
    assert.equal(await readFile(join(dir, "app.js"), "utf8"), "changed\n");
    assert.equal((await loadAllManifests(dir)).filter((x) => x.trigger === "pre_restore").length, 0);
  } finally {
    await rmrf(dir);
  }
});

test("TV-28 overlay keeps extra.md", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "extra.md"), "keep me\n");
    await cli(["restore", m.id, "--yes"], { dir, yes: true });
    assert.equal(existsSync(join(dir, "extra.md")), true);
    assert.equal(await readFile(join(dir, "extra.md"), "utf8"), "keep me\n");
  } finally {
    await rmrf(dir);
  }
});

test("TV-29 exact --yes deletes extra.md and lists it", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "extra.md"), "gone\n");
    const dry = await cli(["restore", m.id, "--exact", "--dry-run"], { dir, yes: true });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /extra\.md/);
    const r = await cli(["restore", m.id, "--exact", "--yes"], { dir, yes: true });
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(dir, "extra.md")), false);
  } finally {
    await rmrf(dir);
  }
});

test("TV-30 EBUSY on one file: locked_failed, others restored, exit 4", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "one.txt"), "a\n");
    await writeFile(join(dir, "two.txt"), "b\n");
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "one.txt"), "A\n");
    await writeFile(join(dir, "two.txt"), "B\n");
    testHooks.ebusyPaths.add(join(dir, "one.txt"));
    const r = await cli(["restore", m.id, "--yes"], { dir, yes: true });
    resetTestHooks();
    assert.equal(r.code, 4);
    assert.match(r.stderr, /E_PARTIAL/);
    assert.equal(await readFile(join(dir, "two.txt"), "utf8"), "b\n");
    assert.equal(await readFile(join(dir, "one.txt"), "utf8"), "A\n");
  } finally {
    resetTestHooks();
    await rmrf(dir);
  }
});

test("TV-32 staging empty after successful restore", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "app.js"), "x\n");
    await cli(["restore", m.id, "--yes"], { dir, yes: true });
    const staging = join(dir, ".localhosting", "staging");
    const names = existsSync(staging) ? await readdir(staging) : [];
    assert.equal(names.length, 0);
  } finally {
    await rmrf(dir);
  }
});

test("TV-33 second restore E_LOCKED while lock held", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const sleeper = spawn("sleep", ["30"]);
    await writeLock(dir, "http://127.0.0.1:1");
    const lockPath = join(dir, ".localhosting", "LOCK");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: sleeper.pid,
        started_at: new Date().toISOString(),
        dashboard: "http://127.0.0.1:1",
      }) + "\n",
    );
    const r = await cli(["restore", m.id, "--yes"], { dir, yes: true });
    sleeper.kill();
    assert.equal(r.code, 6);
    assert.match(r.stderr, /E_LOCKED/);
  } finally {
    await rmrf(dir);
  }
});

test("TV-34 restore does not kill dummy process", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const dummy = spawn("sleep", ["20"]);
    const pid = dummy.pid!;
    await writeFile(join(dir, "app.js"), "changed\n");
    await cli(["restore", m.id, "--yes"], { dir, yes: true });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    dummy.kill();
    assert.equal(alive, true);
  } finally {
    await rmrf(dir);
  }
});

test("TV-36 mistaken restore then safety restore returns B", async () => {
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "tracked.txt"), "A\n");
    await snap(dir);
    const snapA = (await loadAllManifests(dir))[0];
    await writeFile(join(dir, "tracked.txt"), "B\n");
    await snap(dir);
    const r = await cli(["restore", snapA.id, "--yes"], { dir, yes: true, json: true });
    assert.equal(r.code, 0);
    const resp = JSON.parse(r.stdout) as { safety_id: string };
    assert.ok(resp.safety_id);
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "A\n");
    await cli(["restore", resp.safety_id, "--yes"], { dir, yes: true });
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "B\n");
  } finally {
    await rmrf(dir);
  }
});

test("TV-37 unix mode 0755 restored executable", async (t) => {
  if (process.platform === "win32") {
    t.skip("windows");
    return;
  }
  const dir = await makeProject();
  try {
    await writeFile(join(dir, "tool.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(dir, "tool.sh"), 0o755);
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    await chmod(join(dir, "tool.sh"), 0o644);
    await cli(["restore", m.id, "--yes"], { dir, yes: true });
    const st = await stat(join(dir, "tool.sh"));
    assert.equal((st.mode & 0o111) !== 0, true);
  } finally {
    await rmrf(dir);
  }
});

test("TV-38 dry-run makes no writes", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    const [m] = await loadAllManifests(dir);
    const snapStat = await stat(join(dir, ".localhosting", "snapshots", `${m.id}.json`));
    await writeFile(join(dir, "app.js"), "dirty-dry\n");
    const destBefore = await readFile(join(dir, "app.js"), "utf8");
    await new Promise((r) => setTimeout(r, 20));
    const r = await cli(["restore", m.id, "--dry-run"], { dir });
    assert.equal(r.code, 0);
    const snapStat2 = await stat(join(dir, ".localhosting", "snapshots", `${m.id}.json`));
    assert.equal(snapStat2.mtimeMs, snapStat.mtimeMs);
    assert.equal(await readFile(join(dir, "app.js"), "utf8"), destBefore);
    assert.equal((await loadAllManifests(dir)).length, 1);
  } finally {
    await rmrf(dir);
  }
});

test("TV-39 unique prefix restores; ambiguous prefix exits 1", async () => {
  const dir = await makeProject();
  try {
    await snap(dir);
    await writeFile(join(dir, "app.js"), "v2\n");
    await snap(dir);
    const all = await loadAllManifests(dir);
    assert.ok(all.length >= 2);
    const a = all[0].id;
    let uniq = 8;
    while (uniq <= a.length && all.filter((x) => x.id.startsWith(a.slice(0, uniq))).length > 1) {
      uniq++;
    }
    const r = await cli(["restore", a.slice(0, uniq), "--yes"], { dir, yes: true });
    assert.equal(r.code, 0);
    let n = 8;
    const ids = all.map((x) => x.id);
    while (n < ids[0].length && ids.every((id) => id.startsWith(ids[0].slice(0, n)))) n++;
    const common = ids[0].slice(0, Math.max(8, n - 1));
    const amb = await cli(["restore", common, "--yes"], { dir, yes: true });
    assert.equal(amb.code, 1);
  } finally {
    await rmrf(dir);
  }
});

void utimes;
