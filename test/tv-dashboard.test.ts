import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { cli, makeProject, rmrf } from "./helpers.js";
import { listenDashboard, type DashboardRuntime, buildListEnvelope } from "../src/dashboard/listen.js";
import { loadConfig } from "../src/config.js";
import { loadAllManifests } from "../src/store/manifest.js";
import { nextStatusDelayMs, shouldPoll, schedulePoll } from "../src/dashboard/poll.js";
import { RESTART_HINT } from "../src/types.js";

const staticDir = join(dirname(fileURLToPath(import.meta.url)), "../src/dashboard/static");

async function serve(dir: string) {
  const config = await loadConfig(dir);
  const runtime: DashboardRuntime = {
    root: dir,
    config,
    detector: null,
    getPort: () => 0,
  };
  const { server, port, url } = await listenDashboard(runtime, 19151);
  return { server, port, url };
}

test("TV-46 empty store GET / has No snapshots yet and no lorem", async () => {
  const dir = await makeProject();
  const { server, url } = await serve(dir);
  try {
    const res = await fetch(url + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /No snapshots yet/);
    assert.equal(/lorem/i.test(html), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rmrf(dir);
  }
});

test("TV-47 snapshots API fields", async () => {
  const dir = await makeProject();
  try {
    await cli(["snapshot"], { dir, yes: true });
    await writeFile(join(dir, "app.js"), "v2\n");
    await cli(["snapshot"], { dir, yes: true });
    const { server, url } = await serve(dir);
    const res = await fetch(url + "/api/snapshots");
    const env = (await res.json()) as {
      snapshots: Array<{
        id: string;
        trigger: string;
        confidence: string;
        file_count: number;
        total_size: number;
        created_at: string;
      }>;
    };
    assert.ok(env.snapshots.length >= 2);
    for (const s of env.snapshots) {
      assert.ok(s.id);
      assert.ok(s.trigger);
      assert.ok(s.confidence);
      assert.equal(typeof s.file_count, "number");
      assert.equal(typeof s.total_size, "number");
      assert.ok(s.created_at);
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await rmrf(dir);
  }
});

test("TV-48 POST restore without confirm is 400, no tree change", async () => {
  const dir = await makeProject();
  try {
    await cli(["snapshot"], { dir, yes: true });
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "app.js"), "dirty\n");
    const { server, url, port } = await serve(dir);
    const res = await fetch(url + "/api/restore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ id: m.id }),
    });
    assert.equal(res.status, 400);
    assert.equal(await readFile(join(dir, "app.js"), "utf8"), "dirty\n");
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await rmrf(dir);
  }
});

test("TV-49 POST restore with confirm returns hint and safety_id", async () => {
  const dir = await makeProject();
  try {
    await cli(["snapshot"], { dir, yes: true });
    const [m] = await loadAllManifests(dir);
    await writeFile(join(dir, "app.js"), "dirty\n");
    const { server, url, port } = await serve(dir);
    const res = await fetch(url + "/api/restore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ id: m.id, confirm: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hint: string; safety_id: string };
    assert.equal(body.hint, RESTART_HINT);
    assert.ok(body.safety_id);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await rmrf(dir);
  }
});

test("TV-53 GET /api/snapshots matches list --json order", async () => {
  const dir = await makeProject();
  try {
    await cli(["snapshot"], { dir, yes: true });
    await writeFile(join(dir, "app.js"), "v2\n");
    await cli(["snapshot"], { dir, yes: true });
    const list = await cli(["list", "--json"], { dir, json: true });
    const cliEnv = JSON.parse(list.stdout) as { snapshots: Array<{ id: string }> };
    const { server, url } = await serve(dir);
    const api = (await (await fetch(url + "/api/snapshots")).json()) as { snapshots: Array<{ id: string }> };
    assert.deepEqual(
      api.snapshots.map((s) => s.id),
      cliEnv.snapshots.map((s) => s.id),
    );
    const built = await buildListEnvelope(dir);
    assert.deepEqual(
      built.snapshots.map((s) => s.id),
      cliEnv.snapshots.map((s) => s.id),
    );
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    await rmrf(dir);
  }
});

test("TV-54 POST /api/pin sets pinned", async () => {
  const dir = await makeProject({ keepRecent: 2, keepHourly: 0 });
  try {
    await cli(["snapshot"], { dir, yes: true });
    const old = (await loadAllManifests(dir))[0];
    const { server, url, port } = await serve(dir);
    const res = await fetch(url + "/api/pin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ id: old.id, pinned: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pinned: boolean };
    assert.equal(body.pinned, true);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (let i = 0; i < 6; i++) {
      await writeFile(join(dir, "tick.txt"), `x${i}\n`);
      await cli(["snapshot"], { dir, yes: true });
    }
    await cli(["prune"], { dir });
    const all = await loadAllManifests(dir);
    assert.ok(all.some((m) => m.id === old.id && m.pinned));
  } finally {
    await rmrf(dir);
  }
});

test("TV-55 hidden poll helper does not schedule fetches", () => {
  assert.equal(shouldPoll(true), false);
  assert.equal(nextStatusDelayMs(true), null);
  let called = false;
  const handle = schedulePoll(true, 10, () => {
    called = true;
  }, setTimeout);
  assert.equal(handle, null);
  assert.equal(called, false);
  assert.equal(shouldPoll(false), true);
});

test("TV-56 dashboard has no marquee", async () => {
  const html = await readFile(join(staticDir, "index.html"), "utf8");
  const css = await readFile(join(staticDir, "styles.css"), "utf8");
  const js = await readFile(join(staticDir, "app.js"), "utf8");
  assert.equal(/<marquee/i.test(html), false);
  assert.equal(/\bmarquee\b/i.test(css), false);
  assert.equal(/\bmarquee\b/i.test(js), false);
});

test("TV-57 they will be kept is in dashboard assets", async () => {
  const html = await readFile(join(staticDir, "index.html"), "utf8");
  const js = await readFile(join(staticDir, "app.js"), "utf8");
  assert.ok(html.includes("they will be kept") || js.includes("they will be kept"));
});

test("TV-58 no lsof/netstat/kill UI strings in dashboard assets", async () => {
  const html = await readFile(join(staticDir, "index.html"), "utf8");
  const css = await readFile(join(staticDir, "styles.css"), "utf8");
  const js = await readFile(join(staticDir, "app.js"), "utf8");
  const all = html + css + js;
  assert.equal(all.includes("lsof"), false);
  assert.equal(all.includes("netstat -an"), false);
  assert.equal(all.includes("taskkill"), false);
  assert.equal(/kill whatever|kill the process|process killer|manage ports/i.test(all), false);
});
