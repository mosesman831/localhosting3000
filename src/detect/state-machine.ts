import type { ConfigV1, DetectorState, LastProbe } from "../types.js";
import { probeUrl } from "./ssrf.js";
import { probeOnce, toLastProbe } from "./probe.js";
import { commitSnapshot } from "../store/commit.js";
import { writeErr, writeOut } from "../io.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storeDir } from "../paths.js";
import type { Confidence } from "../types.js";
import { computeTreeHash, walkInclude } from "../include/walk.js";
import { latestManifest } from "../store/manifest.js";

export interface DetectorHooks {
  onSnapshot?: (line: string) => void;
  onSkipDup?: (line: string) => void;
}

export class Detector {
  state: DetectorState = "DIRTY";
  streak = 0;
  lastRealCommitAt = 0;
  lastProbe: LastProbe;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private dirtyDuringSnapshot = false;
  private stopped = false;
  restoring = false;
  restoringId: string | null = null;
  private retryAfterCooldown = false;

  constructor(
    readonly root: string,
    public config: ConfigV1,
    readonly hooks: DetectorHooks = {},
  ) {
    this.lastProbe = {
      url: probeUrl(config.url, config.probePath),
      last_status: null,
      last_overlay: null,
      last_error: null,
      last_at: null,
    };
  }

  start(): void {
    this.stopped = false;
    this.enterDirty();
  }

  stop(): void {
    this.stopped = true;
    this.clearSettle();
    this.clearProbe();
    this.state = "STOPPED";
  }

  pause(): void {
    this.clearSettle();
    this.clearProbe();
    this.state = "PAUSED";
  }

  beginRestore(id: string): void {
    this.restoring = true;
    this.restoringId = id;
    if (this.state !== "SNAPSHOTTING") {
      this.clearSettle();
      this.clearProbe();
      this.state = "BLOCKED";
    }
  }

  endRestore(): void {
    this.restoring = false;
    this.restoringId = null;
    if (this.stopped) return;
    if (this.state === "PAUSED") return;
    this.enterDirty();
  }

  onIncludedFileEvent(): void {
    if (this.stopped || this.state === "PAUSED") return;
    if (this.state === "BLOCKED") return;
    if (this.state === "SNAPSHOTTING") {
      this.dirtyDuringSnapshot = true;
      return;
    }
    this.enterDirty();
  }

  private enterDirty(): void {
    this.state = "DIRTY";
    this.streak = 0;
    this.clearProbe();
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.state !== "DIRTY" || this.stopped) return;
      this.state = "SETTLING";
      this.enterProbing();
    }, this.config.settleMs);
  }

  private enterProbing(): void {
    this.state = "PROBING";
    this.streak = 0;
    this.clearProbe();
    void this.probeTick();
    this.probeTimer = setInterval(() => {
      void this.probeTick();
    }, this.config.probeIntervalMs);
  }

  private async probeTick(): Promise<void> {
    if (this.state !== "PROBING" || this.stopped) return;
    const url = probeUrl(this.config.url, this.config.probePath);
    const r = await probeOnce(url, {
      timeoutMs: this.config.probeTimeoutMs,
      overlaySignatures: this.config.overlaySignatures,
    });
    this.lastProbe = toLastProbe(url, r);
    await persistProbe(this.root, this.lastProbe);
    if (this.state !== "PROBING" || this.stopped) return;
    if (!r.ok) {
      this.streak = 0;
      return;
    }
    this.streak += 1;
    if (this.streak < this.config.probeSuccessCount) return;
    await this.onStreakSuccess(r.confidence as Confidence, r.status);
  }

  private async onStreakSuccess(
    confidence: Confidence,
    status: number | null,
  ): Promise<void> {
    this.clearProbe();
    const now = Date.now();
    const intervalOk =
      this.lastRealCommitAt === 0 ||
      now - this.lastRealCommitAt >= this.config.minSnapshotIntervalMs;

    this.dirtyDuringSnapshot = false;
    try {
      const walked = await walkInclude(this.root, this.config);
      const hash = computeTreeHash(walked.files);
      const latest = await latestManifest(this.root);
      if (latest && latest.tree_hash === hash) {
        const result = await commitSnapshot({
          root: this.root,
          config: this.config,
          trigger: "good_build",
          confidence,
          probe_url: probeUrl(this.config.url, this.config.probePath),
          probe_status: status,
          deferPrune: this.restoring,
          restoringId: this.restoringId,
        });
        const line = `good state unchanged  ${result.id}  last_seen_good_at=${result.manifest.last_seen_good_at}`;
        writeOut(line);
        this.hooks.onSkipDup?.(line);
        this.state = "IDLE";
        if (this.dirtyDuringSnapshot) this.enterDirty();
        return;
      }
    if (!intervalOk) {
      this.retryAfterCooldown = true;
      this.state = "COOLDOWN";
      this.scheduleCooldown();
      if (this.dirtyDuringSnapshot) this.enterDirty();
      return;
    }

      this.state = "SNAPSHOTTING";
      const result = await commitSnapshot({
        root: this.root,
        config: this.config,
        trigger: "good_build",
        confidence,
        probe_url: probeUrl(this.config.url, this.config.probePath),
        probe_status: status,
        deferPrune: this.restoring,
        restoringId: this.restoringId,
      });
      if (result.skipDup) {
        const line = `good state unchanged  ${result.id}  last_seen_good_at=${result.manifest.last_seen_good_at}`;
        writeOut(line);
        this.hooks.onSkipDup?.(line);
        this.state = "IDLE";
        if (this.dirtyDuringSnapshot) this.enterDirty();
        return;
      }
      this.lastRealCommitAt = Date.now();
      const m = result.manifest;
      const line = `snapshot ${m.id}  files=${m.file_count}  size=${m.total_size}  confidence=${m.confidence}`;
      writeOut(line);
      this.hooks.onSnapshot?.(line);
      this.state = "COOLDOWN";
      this.scheduleCooldown();
    } catch (err) {
      const e = err as Error;
      writeErr(`localhosting: snapshot failed ${e.message}`);
      this.state = "DIRTY";
      this.enterDirty();
      return;
    }
    if (this.dirtyDuringSnapshot) this.enterDirty();
  }

  private scheduleCooldown(): void {
    this.clearSettle();
    const wait = Math.max(
      0,
      this.config.minSnapshotIntervalMs - (Date.now() - this.lastRealCommitAt),
    );
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.state !== "COOLDOWN" || this.stopped) return;
      if (this.retryAfterCooldown) {
        this.retryAfterCooldown = false;
        this.enterDirty();
        return;
      }
      this.state = "IDLE";
    }, wait);
  }

  private clearSettle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }
}

async function persistProbe(root: string, probe: LastProbe): Promise<void> {
  const dir = join(storeDir(root), "cache");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "last-probe.json"), JSON.stringify(probe) + "\n", "utf8");
}
