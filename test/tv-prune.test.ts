import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli, makeProject, rmrf } from "./helpers.js";
import { loadAllManifests } from "../src/store/manifest.js";
import { selectKeepIds, pruneStore } from "../src/store/prune.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ManifestV1 } from "../src/types.js";

function fake(partial: Partial<ManifestV1> & { id: string; created_at: string; trigger: ManifestV1["trigger"] }): ManifestV1 {
  return {
    schema: "localhosting.snapshot.v1",
    last_seen_good_at: partial.created_at,
    confidence: "manual",
    pinned: false,
    root: "/tmp",
    probe_url: null,
    probe_status: null,
    file_count: 1,
    total_size: 1,
    tree_hash: partial.id.padEnd(64, "0").slice(0, 64),
    parent_id: null,
    files: [],
    skipped: [],
    skipped_truncated: false,
    ...partial,
  };
}

async function snapN(dir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await writeFile(join(dir, "tick.txt"), `n${i}\n`);
    const r = await cli(["snapshot"], { dir, yes: true });
    assert.equal(r.code, 0);
  }
}

test("TV-40 keepRecent=18 keeps exactly 18 manuals", async () => {
  const dir = await makeProject({ keepRecent: 18, keepHourly: 0, keepSafety: 3 });
  try {
    await snapN(dir, 30);
    const r = await cli(["prune"], { dir });
    assert.equal(r.code, 0);
    const all = await loadAllManifests(dir);
    const manuals = all.filter((m) => m.trigger === "manual");
    assert.equal(manuals.length, 18);
  } finally {
    await rmrf(dir);
  }
});

test("TV-41 pinned old snapshot survives 30 new", async () => {
  const dir = await makeProject({ keepRecent: 18, keepHourly: 0 });
  try {
    await writeFile(join(dir, "tick.txt"), "old\n");
    await cli(["snapshot", "--pin"], { dir, yes: true });
    const pinned = (await loadAllManifests(dir))[0];
    assert.equal(pinned.pinned, true);
    await snapN(dir, 30);
    const all = await loadAllManifests(dir);
    assert.ok(all.some((m) => m.id === pinned.id && m.pinned));
  } finally {
    await rmrf(dir);
  }
});

test("TV-42 size cap never deletes newest", async () => {
  const dir = await makeProject({ keepRecent: 18, keepHourly: 0, maxStoreMb: 50 });
  try {
    await snapN(dir, 5);
    const newest = (await loadAllManifests(dir))[0];
    const cfg = { ...DEFAULT_CONFIG, keepRecent: 18, keepHourly: 0, maxStoreMb: 0 };
    await pruneStore(dir, cfg);
    const all = await loadAllManifests(dir);
    assert.ok(all.some((m) => m.id === newest.id));
  } finally {
    await rmrf(dir);
  }
});

test("TV-43 keepSafety 3 drops oldest of 4 pre_restore", () => {
  const snaps: ManifestV1[] = [];
  for (let i = 0; i < 4; i++) {
    snaps.push(
      fake({
        id: `lh_20260904T12000${i}_aabbccdd`,
        created_at: `2026-09-04T12:00:0${i}.000Z`,
        trigger: "pre_restore",
        confidence: "manual",
      }),
    );
  }
  const keep = selectKeepIds(snaps, { ...DEFAULT_CONFIG, keepRecent: 18, keepHourly: 0, keepSafety: 3 });
  const remaining = snaps.filter((s) => keep.has(s.id)).map((s) => s.id);
  assert.equal(remaining.length, 3);
  assert.equal(remaining.includes("lh_20260904T120000_aabbccdd"), false);
});

test("TV-45 prune --dry-run lists the same set twice, then real prune deletes it", async () => {
  const dir = await makeProject({ keepRecent: 100, keepHourly: 0, keepSafety: 3 });
  try {
    await snapN(dir, 6);
    await writeFile(
      join(dir, ".localhosting", "config.json"),
      JSON.stringify({ ...DEFAULT_CONFIG, keepRecent: 2, keepHourly: 0, keepSafety: 3 }, null, 2) + "\n",
    );
    const a = await cli(["prune", "--dry-run"], { dir });
    const b = await cli(["prune", "--dry-run"], { dir });
    assert.equal(a.stdout, b.stdout);
    const ids = a.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("lh_"));
    assert.ok(ids.length > 0);
    const before = await loadAllManifests(dir);
    const real = await cli(["prune"], { dir });
    const deleted = real.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("lh_"));
    assert.deepEqual([...deleted].sort(), [...ids].sort());
    const after = await loadAllManifests(dir);
    for (const id of ids) {
      assert.equal(after.some((m) => m.id === id), false);
    }
    assert.equal(after.length, before.length - ids.length);
  } finally {
    await rmrf(dir);
  }
});
