import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { CliError } from "../errors.js";
import { loadConfig } from "../config.js";
import { Detector } from "../detect/state-machine.js";
import { walkInclude } from "../include/walk.js";
import { readLock, writeLock } from "../lock.js";
import { restoreSnapshot } from "../restore/restore.js";
import { commitSnapshot } from "../store/commit.js";
import { bytesOnDisk } from "../store/gc.js";
import { loadAllManifests, loadManifest, resolveSnapshotId } from "../store/manifest.js";
import { pruneStore } from "../store/prune.js";
import { appendJournal } from "../store/journal.js";
import { neighborDelta } from "../diff/counts.js";
import { storeDir } from "../paths.js";
import { writeErr } from "../io.js";
import type {
  ConfigV1,
  ListEnvelope,
  ManifestV1,
  RestoreRequest,
  SnapshotSummary,
  StatusEnvelope,
} from "../types.js";
import { RESTART_HINT } from "../types.js";
import { existsSync } from "node:fs";
import { join as pjoin } from "node:path";

export interface DashboardRuntime {
  root: string;
  config: ConfigV1;
  detector: Detector | null;
  getPort: () => number;
}

function staticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "static");
  const src = join(here, "../../src/dashboard/static");
  if (existsSync(join(dist, "index.html"))) return dist;
  return src;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export async function listenDashboard(
  runtime: DashboardRuntime,
  startPort: number,
): Promise<{ server: Server; port: number; url: string }> {
  if (startPort === 3000) {
    throw new CliError("E_PORT_3000", "dashboard must not bind port 3000");
  }
  const max = startPort >= 3001 && startPort <= 3010 ? 3010 : startPort;
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let port = startPort; port <= max; port++) {
    if (port === 3000) continue;
    try {
      const server = await bind(port, runtime);
      const url = `http://127.0.0.1:${port}`;
      return { server, port, url };
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException;
      if (lastErr.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new CliError("E_BIND", "dashboard ports 3001-3010 all busy");
}

function bind(port: number, runtime: DashboardRuntime): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res, runtime, port);
    });
    server.keepAliveTimeout = 1;
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(data);
}

function originOk(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? "";
  const okHost =
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`;
  if (!okHost) return false;
  const origin = req.headers.origin;
  if (origin) {
    return (
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}` ||
      origin === `http://[::1]:${port}`
    );
  }
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildListEnvelope(root: string): Promise<ListEnvelope> {
  const all = await loadAllManifests(root);
  const snapshots: SnapshotSummary[] = all.map((m, i) => {
    const older = all[i + 1];
    const delta = older ? neighborDelta(m.files, older.files) : null;
    return {
      id: m.id,
      created_at: m.created_at,
      last_seen_good_at: m.last_seen_good_at,
      trigger: m.trigger,
      confidence: m.confidence,
      pinned: m.pinned,
      file_count: m.file_count,
      total_size: m.total_size,
      tree_hash: m.tree_hash,
      delta,
      age_ms: Date.now() - Date.parse(m.created_at),
    };
  });
  return { schema: "localhosting.list.v1", dir: root, snapshots };
}

export async function buildStatus(runtime: DashboardRuntime): Promise<StatusEnvelope> {
  const lock = await readLock(runtime.root);
  const all = await loadAllManifests(runtime.root);
  const bytes = await bytesOnDisk(runtime.root);
  let estimate: number | null = null;
  try {
    const w = await walkInclude(runtime.root, runtime.config);
    estimate = w.files.length;
  } catch {
    estimate = null;
  }
  const journalPath = pjoin(storeDir(runtime.root), "restore-journal.json");
  let restore_journal_present = false;
  try {
    await readFile(journalPath);
    restore_journal_present = true;
  } catch {
    restore_journal_present = false;
  }
  const det = runtime.detector;
  return {
    schema: "localhosting.status.v1",
    dir: runtime.root,
    detector: det ? det.state : "STOPPED",
    probe: det
      ? det.lastProbe
      : {
          url: runtime.config.url,
          last_status: null,
          last_overlay: null,
          last_error: null,
          last_at: null,
        },
    lock: lock ? { pid: lock.pid, started_at: lock.started_at } : null,
    store: { snapshot_count: all.length, bytes_on_disk: bytes },
    restore_journal_present,
    included_file_count_estimate: estimate,
  };
}

async function pinManifest(
  root: string,
  id: string,
  pinned: boolean,
  config: ConfigV1,
  force = false,
): Promise<ManifestV1> {
  const resolved = await resolveSnapshotId(root, id);
  const all = await loadAllManifests(root);
  const m = all.find((x) => x.id === resolved);
  if (!m) throw new CliError("E_ID", `unknown snapshot id ${id}`);
  if (pinned && !m.pinned) {
    const pins = all.filter((x) => x.pinned);
    if (pins.length >= config.maxPins) {
      if (!force) {
        throw new CliError("E_USAGE", `pin cap ${config.maxPins} reached; use --force-pin`);
      }
      pins.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      const oldest = pins[0];
      oldest.pinned = false;
      const { writeManifestAtomic } = await import("../store/manifest.js");
      await writeManifestAtomic(root, oldest);
    }
  }
  m.pinned = pinned;
  const { writeManifestAtomic } = await import("../store/manifest.js");
  await writeManifestAtomic(root, m);
  await appendJournal(root, "pin", m.id, { pinned });
  return m;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: DashboardRuntime,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && url.pathname === "/api/status") {
      json(res, 200, await buildStatus(runtime));
      return;
    }
    if (method === "GET" && url.pathname === "/api/snapshots") {
      json(res, 200, await buildListEnvelope(runtime.root));
      return;
    }
    const detail = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
    if (method === "GET" && detail) {
      const id = decodeURIComponent(detail[1]);
      const resolved = await resolveSnapshotId(runtime.root, id);
      json(res, 200, await loadManifest(runtime.root, resolved));
      return;
    }
    const plan = url.pathname.match(/^\/api\/restore-plan\/([^/]+)$/);
    if (method === "GET" && plan) {
      const id = decodeURIComponent(plan[1]);
      const resolved = await resolveSnapshotId(runtime.root, id);
      const target = await loadManifest(runtime.root, resolved);
      const current = await walkInclude(runtime.root, runtime.config);
      const d = (await import("../diff/counts.js")).diffTrees(current.files, target.files);
      json(res, 200, {
        overwrite: d.overwrite.length,
        create: d.create.length,
        extra: d.extra.length,
        overwrite_paths: d.overwrite.slice(0, 50),
        extra_paths: d.extra.slice(0, 50),
      });
      return;
    }

    if (method === "POST") {
      if (!originOk(req, port)) {
        json(res, 403, { ok: false, error: "forbidden origin" });
        return;
      }
      const ct = (req.headers["content-type"] ?? "").split(";")[0].trim();
      if (ct !== "application/json") {
        json(res, 400, { ok: false, error: "Content-Type must be application/json" });
        return;
      }
      const raw = await readBody(req);
      let body: unknown = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { ok: false, error: "invalid json" });
          return;
        }
      }

      if (url.pathname === "/api/restore") {
        const b = body as Partial<RestoreRequest>;
        if (b.confirm !== true || typeof b.id !== "string") {
          json(res, 400, { ok: false, error: "confirm:true and id required" });
          return;
        }
        const journalPath = pjoin(storeDir(runtime.root), "restore-journal.json");
        try {
          await readFile(journalPath);
          json(res, 409, { ok: false, error: "restore already in progress" });
          return;
        } catch {
          /* ok */
        }
        runtime.detector?.beginRestore(b.id);
        try {
          const result = await restoreSnapshot(runtime.root, runtime.config, b.id, {
            exact: b.exact === true,
            confirmed: true,
            deferPrune: true,
          });
          await pruneStore(runtime.root, runtime.config, {});
          json(res, 200, result);
        } catch (err) {
          const e = err as CliError;
          json(res, e.exitCode === 1 ? 400 : 500, {
            ok: false,
            code: e.code ?? "E_FAIL",
            message: e.message,
          });
        } finally {
          runtime.detector?.endRestore();
        }
        return;
      }

      if (url.pathname === "/api/pin") {
        const b = body as { id?: string; pinned?: boolean; force?: boolean };
        if (typeof b.id !== "string" || typeof b.pinned !== "boolean") {
          json(res, 400, { ok: false, error: "id and pinned required" });
          return;
        }
        const m = await pinManifest(
          runtime.root,
          b.id,
          b.pinned,
          runtime.config,
          b.force !== false,
        );
        json(res, 200, { ok: true, id: m.id, pinned: m.pinned });
        return;
      }

      if (url.pathname === "/api/snapshot") {
        const b = body as { pin?: boolean };
        const result = await commitSnapshot({
          root: runtime.root,
          config: runtime.config,
          trigger: "manual",
          confidence: "manual",
          probe_url: null,
          probe_status: null,
        });
        if (b.pin) {
          await pinManifest(runtime.root, result.id, true, runtime.config, true);
        }
        json(res, 200, { ok: true, id: result.id, skipDup: result.skipDup });
        return;
      }

      if (url.pathname === "/api/prune") {
        const b = body as { dryRun?: boolean };
        const r = await pruneStore(runtime.root, runtime.config, { dryRun: !!b.dryRun });
        json(res, 200, { ok: true, deleteIds: r.deleteIds, overCap: r.overCap });
        return;
      }

      json(res, 404, { ok: false, error: "not found" });
      return;
    }

    if (method === "GET") {
      let rel = url.pathname === "/" ? "/index.html" : url.pathname;
      if (rel.includes("..")) {
        json(res, 400, { ok: false, error: "bad path" });
        return;
      }
      const file = join(staticDir(), rel.slice(1));
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        });
        res.end(data);
        return;
      } catch {
        json(res, 404, { ok: false, error: "not found" });
        return;
      }
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    const e = err as CliError;
    writeErr(`localhosting: dashboard ${e.message}`);
    json(res, e instanceof CliError && e.exitCode === 1 ? 400 : 500, {
      ok: false,
      code: e.code ?? "E_FAIL",
      message: e.message,
    });
  }
}

export { pinManifest, loadConfig };
void writeLock;
void RESTART_HINT;
