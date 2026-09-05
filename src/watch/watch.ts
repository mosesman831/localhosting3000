import chokidar from "chokidar";
import { relative } from "node:path";
import { loadConfig } from "../config.js";
import { Detector } from "../detect/state-machine.js";
import { assertLoopbackUrl, probeUrl } from "../detect/ssrf.js";
import { pathIsIncluded, watchEventIgnored } from "../include/walk.js";
import { writeOut } from "../io.js";
import { acquireWatchLock, unlock, writeLock } from "../lock.js";
import { isForbiddenRoot, toPosix } from "../paths.js";
import { gcOnStart } from "../store/gc.js";
import { listenDashboard, type DashboardRuntime } from "../dashboard/listen.js";
import { CliError } from "../errors.js";
import type { ConfigV1 } from "../types.js";

export interface WatchOpts {
  url?: string;
  probePath?: string;
  dashboardPort?: number;
  includeEnv?: boolean;
  paused?: boolean;
  signal?: AbortSignal;
}

export async function runWatch(root: string, opts: WatchOpts = {}): Promise<void> {
  if (await isForbiddenRoot(root)) {
    throw new CliError("E_HOME", "refusing to watch / , a drive root, or $HOME");
  }
  const { ensureStore } = await import("../config.js");
  await ensureStore(root);
  let config: ConfigV1 = await loadConfig(root);
  if (opts.url) config = { ...config, url: opts.url };
  if (opts.probePath) config = { ...config, probePath: opts.probePath };
  if (opts.dashboardPort != null) config = { ...config, dashboardPort: opts.dashboardPort };
  if (opts.includeEnv === false) config = { ...config, includeEnv: false };
  if (config.dashboardPort === 3000) {
    throw new CliError("E_PORT_3000", "dashboard must not bind port 3000");
  }

  await assertLoopbackUrl(config.url);

  await acquireWatchLock(root);
  await gcOnStart(root);

  const detector = new Detector(root, config);
  const runtime: DashboardRuntime = {
    root,
    config,
    detector,
    getPort: () => port,
  };

  let port = config.dashboardPort;
  const { server, port: bound, url: dashUrl } = await listenDashboard(runtime, config.dashboardPort);
  port = bound;
  runtime.config = { ...config, dashboardPort: bound };
  await writeLock(root, dashUrl);

  const probe = probeUrl(config.url, config.probePath);
  if (!opts.paused) {
    writeOut("localhosting watch");
    writeOut(`root:      ${root}`);
    writeOut(`probe:     ${probe}`);
    writeOut(`dashboard: ${dashUrl}`);
    writeOut(
      `waiting for a good state (settle ${config.settleMs}ms, probe streak ${config.probeSuccessCount})`,
    );
    detector.start();
  } else {
    writeOut("localhosting serve");
    writeOut(`root:      ${root}`);
    writeOut(`dashboard: ${dashUrl}`);
    detector.pause();
  }

  const watcher = chokidar.watch(root, {
    ignored: (p: string) => {
      const rel = toPosix(relative(root, p));
      if (!rel || rel === ".") return false;
      return watchEventIgnored(rel);
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    ignorePermissionErrors: true,
  });

  const onFs = async (p: string) => {
    const rel = toPosix(relative(root, p));
    if (!rel || watchEventIgnored(rel)) return;
    if (await pathIsIncluded(root, rel, config)) detector.onIncludedFileEvent();
  };
  watcher.on("add", (p) => void onFs(p));
  watcher.on("change", (p) => void onFs(p));
  watcher.on("unlink", (p) => void onFs(p));

  let stopped = false;
  let onStopped: () => void = () => undefined;
  let onFailed: (e: unknown) => void = () => undefined;

  const onInt = () => {
    void stop().then(onStopped, onFailed);
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    detector.stop();
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onInt);
    opts.signal?.removeEventListener("abort", onInt);
    await watcher.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      try {
        server.closeAllConnections();
      } catch {
        /* older node */
      }
      server.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await unlock(root);
  };

  if (opts.signal?.aborted) {
    await stop();
    return;
  }
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onInt);
  if (opts.signal) {
    opts.signal.addEventListener("abort", onInt);
  }

  await new Promise<void>((resolve, reject) => {
    onStopped = resolve;
    onFailed = reject;
  });
}
