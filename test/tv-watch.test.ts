import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli, makeProject, occupyPort, rmrf, startProbe, waitFor, Collect } from "./helpers.js";
import { run } from "../src/cli.js";
import { PassThrough } from "node:stream";
import type { Io } from "../src/io.js";
import { loadAllManifests } from "../src/store/manifest.js";
import { listenDashboard, type DashboardRuntime } from "../src/dashboard/listen.js";
import { loadConfig, writeDefaultConfig } from "../src/config.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

function ioFor(dir: string, stdout: Collect, stderr: Collect, signal?: AbortSignal): Io {
  void signal;
  return {
    stdout,
    stderr,
    stdin: new PassThrough(),
    json: false,
    yes: true,
    dir,
    env: process.env,
  };
}

async function watchUntil(
  dir: string,
  probeUrl: string,
  dashboardPort: number,
  pred: () => Promise<boolean>,
  timeoutMs = 20000,
): Promise<{ stop: () => void; stdout: Collect; stderr: Collect }> {
  const ac = new AbortController();
  const stdout = new Collect();
  const stderr = new Collect();
  const p = run(
    [
      "--dir",
      dir,
      "watch",
      "--url",
      probeUrl,
      "--dashboard-port",
      String(dashboardPort),
    ],
    { io: ioFor(dir, stdout, stderr), signal: ac.signal },
  );
  p.catch(() => undefined);
  try {
    await waitFor(pred, timeoutMs);
  } catch (e) {
    ac.abort();
    throw e;
  }
  return {
    stop: async () => {
      ac.abort();
      await p.catch(() => undefined);
    },
    stdout,
    stderr,
  };
}

test("TV-01 first good-state commit", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    dashboardPort: 19011,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19011, async () => {
      const all = await loadAllManifests(dir);
      return all.some((m) => m.trigger === "good_build");
    });
    const all = await loadAllManifests(dir);
    const m = all.find((x) => x.trigger === "good_build")!;
    assert.ok(m.file_count >= 1);
    assert.equal(m.tree_hash.length, 64);
    await w.stop();
    probe.server.close();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-02 identical tree_hash skip_dup", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19012, async () => (await loadAllManifests(dir)).length >= 1);
    const first = (await loadAllManifests(dir))[0];
    const seen = first.last_seen_good_at;
    await waitFor(async () => {
      const m = (await loadAllManifests(dir))[0];
      return m.last_seen_good_at !== seen && (await loadAllManifests(dir)).length === 1;
    }, 10000).catch(() => undefined);
    await writeFile(join(dir, "index.html"), await (await import("node:fs/promises")).readFile(join(dir, "index.html")));
    await new Promise((r) => setTimeout(r, 1500));
    const all = await loadAllManifests(dir);
    assert.equal(all.length, 1);
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-05 no watcher feedback loop within 5s", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19013, async () => (await loadAllManifests(dir)).length >= 1);
    const n = (await loadAllManifests(dir)).length;
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal((await loadAllManifests(dir)).length, n);
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-15 writes under .localhosting/objects do not DIRTY", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19014, async () => {
      try {
        const res = await fetch("http://127.0.0.1:19014/api/status");
        if (!res.ok) return false;
        const s = (await res.json()) as { detector: string };
        return s.detector === "IDLE" || s.detector === "COOLDOWN" || s.detector === "PROBING";
      } catch {
        return false;
      }
    });
    const before = await (await fetch("http://127.0.0.1:19014/api/status")).json() as { detector: string };
    const obj = join(dir, ".localhosting", "objects");
    await mkdir(obj, { recursive: true });
    for (let i = 0; i < 100; i++) {
      await writeFile(join(obj, `n${i}.bin`), "x");
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = await (await fetch("http://127.0.0.1:19014/api/status")).json() as { detector: string };
    assert.notEqual(after.detector, "DIRTY");
    void before;
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-16 min interval blocks second distinct snapshot", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19015, async () => (await loadAllManifests(dir)).length >= 1);
    const t0 = Date.now();
    await writeFile(join(dir, "app.js"), `changed ${Date.now()}\n`);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await loadAllManifests(dir)).length, 1);
    await waitFor(async () => (await loadAllManifests(dir)).length >= 2, 8000);
    assert.ok(Date.now() - t0 >= 4000);
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-17 overlay HTML does not snapshot", { timeout: 20000 }, async () => {
  const probe = await startProbe({
    body: "<html><body><vite-error-overlay></vite-error-overlay></body></html>",
  });
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const ac = new AbortController();
    const stdout = new Collect();
    const stderr = new Collect();
    const p = run(["--dir", dir, "watch", "--url", probe.url, "--dashboard-port", "19016"], {
      io: ioFor(dir, stdout, stderr),
      signal: ac.signal,
    });
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await loadAllManifests(dir)).filter((m) => m.trigger === "good_build").length, 0);
    ac.abort();
    await p.catch(() => undefined);
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-18 HTTP 500 no snapshot", { timeout: 20000 }, async () => {
  const probe = await startProbe({ status: 500, body: "ok", type: "text/plain" });
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    url: probe.url,
  });
  try {
    const ac = new AbortController();
    const stdout = new Collect();
    const stderr = new Collect();
    const p = run(["--dir", dir, "watch", "--url", probe.url, "--dashboard-port", "19017"], {
      io: ioFor(dir, stdout, stderr),
      signal: ac.signal,
    });
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await loadAllManifests(dir)).length, 0);
    ac.abort();
    await p.catch(() => undefined);
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-19 overlay_clean confidence", { timeout: 30000 }, async () => {
  const probe = await startProbe({ body: "<!doctype html><html><body>fine</body></html>" });
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19018, async () =>
      (await loadAllManifests(dir)).some((m) => m.confidence === "overlay_clean"),
    );
    const m = (await loadAllManifests(dir))[0];
    assert.equal(m.confidence, "overlay_clean");
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-20 non-loopback url E_URL no listen", async () => {
  const dir = await makeProject();
  try {
    const r = await cli(["watch", "--url", "http://203.0.113.1/"], { dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E_URL/);
  } finally {
    await rmrf(dir);
  }
});

test("TV-22 JSON 200 is http_stable", { timeout: 30000 }, async () => {
  const probe = await startProbe({
    body: JSON.stringify({ ok: true }),
    type: "application/json",
  });
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19019, async () =>
      (await loadAllManifests(dir)).some((m) => m.confidence === "http_stable"),
    );
    assert.equal((await loadAllManifests(dir))[0].confidence, "http_stable");
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-31 restore proxies to dashboard; dead dashboard E_LOCKED", { timeout: 40000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19020, async () => (await loadAllManifests(dir)).length >= 1);
    const id = (await loadAllManifests(dir))[0].id;
    await writeFile(join(dir, "app.js"), "dirty-for-proxy\n");
    const r = await cli(["restore", id, "--yes"], { dir, yes: true });
    assert.ok(r.code === 0 || r.code === 4);
    await w.stop();
    await new Promise((r) => setTimeout(r, 300));
    const sleeperPid = process.pid;
    await writeFile(
      join(dir, ".localhosting", "LOCK"),
      JSON.stringify({
        pid: sleeperPid,
        started_at: new Date().toISOString(),
        dashboard: "http://127.0.0.1:1",
      }) + "\n",
    );
    const r2 = await cli(["restore", id, "--yes"], { dir, yes: true });
    assert.equal(r2.code, 6);
    assert.match(r2.stderr, /E_LOCKED/);
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-44 skip_dup does not grow snapshot count", { timeout: 30000 }, async () => {
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    minSnapshotIntervalMs: 5000,
    url: probe.url,
  });
  try {
    const w = await watchUntil(dir, probe.url, 19021, async () => (await loadAllManifests(dir)).length >= 1);
    const n = (await loadAllManifests(dir)).length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await loadAllManifests(dir)).length, n);
    await w.stop();
  } finally {
    probe.server.close();
    await rmrf(dir);
  }
});

test("TV-50 listen address is 127.0.0.1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lh-"));
  await writeDefaultConfig(dir);
  const config = await loadConfig(dir);
  const runtime: DashboardRuntime = {
    root: dir,
    config,
    detector: null,
    getPort: () => 0,
  };
  const { server, port } = await listenDashboard(runtime, 19022);
  const addr = server.address() as AddressInfo;
  assert.equal(addr.address, "127.0.0.1");
  assert.notEqual(port, 3000);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rmrf(dir);
});

test("TV-51 --dashboard-port 3000 exits E_PORT_3000", async () => {
  const dir = await makeProject();
  try {
    const r = await cli(["watch", "--dashboard-port", "3000"], { dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E_PORT_3000/);
  } finally {
    await rmrf(dir);
  }
});

test("TV-52 port 3001 occupied binds next", { timeout: 20000 }, async () => {
  const blocker = await occupyPort(3001);
  const probe = await startProbe({});
  const dir = await makeProject({
    settleMs: 200,
    probeIntervalMs: 100,
    probeSuccessCount: 2,
    url: probe.url,
  });
  try {
    const ac = new AbortController();
    const stdout = new Collect();
    const stderr = new Collect();
    const p = run(["--dir", dir, "watch", "--url", probe.url], {
      io: ioFor(dir, stdout, stderr),
      signal: ac.signal,
    });
    p.catch(() => undefined);
    await waitFor(() => stdout.text().includes("dashboard: http://127.0.0.1:"), 10000);
    const text = stdout.text();
    assert.match(text, /dashboard: http:\/\/127\.0\.0\.1:300[2-9]|dashboard: http:\/\/127\.0\.0\.1:3010/);
    assert.equal(text.includes(":3001\n") && text.includes("dashboard: http://127.0.0.1:3001"), false);
    ac.abort();
    await p.catch(() => undefined);
  } finally {
    blocker.closeAllConnections();
    probe.server.close();
    await rmrf(dir);
  }
});

void cli;
