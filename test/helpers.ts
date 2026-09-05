import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { run } from "../src/cli.js";
import { DEFAULT_CONFIG, writeDefaultConfig } from "../src/config.js";
import type { ConfigV1 } from "../src/types.js";
import type { Io as IoType } from "../src/io.js";

export class Collect extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export async function makeProject(cfg: Partial<ConfigV1> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lh-"));
  await writeFile(join(dir, "index.html"), "<html><body>ok</body></html>\n");
  await writeFile(join(dir, "app.js"), "console.log(1)\n");
  await writeDefaultConfig(dir);
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  await writeFile(join(dir, ".localhosting", "config.json"), JSON.stringify(merged, null, 2) + "\n");
  return dir;
}

export async function rmrf(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function cli(
  args: string[],
  opts: { dir: string; yes?: boolean; json?: boolean; stdin?: NodeJS.ReadableStream },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Collect();
  const stderr = new Collect();
  const stdin = opts.stdin ?? new PassThrough();
  const io: IoType = {
    stdout,
    stderr,
    stdin: stdin as IoType["stdin"],
    json: !!opts.json,
    yes: opts.yes ?? args.includes("--yes"),
    dir: opts.dir,
    env: process.env,
  };
  const code = await run(
    [
      "--dir",
      opts.dir,
      ...(opts.yes ? ["--yes"] : []),
      ...(opts.json ? ["--json"] : []),
      ...args,
    ],
    { io },
  );
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function startProbe(opts: {
  status?: number;
  body?: string;
  type?: string;
}): Promise<{ server: Server; url: string; port: number; set: (o: { status?: number; body?: string; type?: string }) => void }> {
  let status = opts.status ?? 200;
  let body = opts.body ?? "<!doctype html><html><body>hello</body></html>";
  let type = opts.type ?? "text/html";
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": type, Connection: "close" });
    res.end(body);
  });
  server.keepAliveTimeout = 1;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        set: (o) => {
          if (o.status != null) status = o.status;
          if (o.body != null) body = o.body;
          if (o.type != null) type = o.type;
        },
      });
    });
  });
}

export async function occupyPort(port: number): Promise<Server> {
  const s = createServer((_q, r) => r.end("x"));
  await new Promise<void>((resolve, reject) => {
    s.listen(port, "127.0.0.1", () => resolve());
    s.on("error", reject);
  });
  return s;
}

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}

void mkdir;
void join;
