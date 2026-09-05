export type Trigger = "good_build" | "manual" | "pre_restore";
export type Confidence = "overlay_clean" | "http_stable" | "manual";
export type FileType = "file" | "symlink";

export type DetectorState =
  | "IDLE"
  | "DIRTY"
  | "SETTLING"
  | "PROBING"
  | "SNAPSHOTTING"
  | "COOLDOWN"
  | "BLOCKED"
  | "PAUSED"
  | "STOPPED";

export interface ConfigV1 {
  schema: "localhosting.config.v1";
  url: string;
  probePath: string;
  dashboardPort: number;
  bind: "127.0.0.1";
  keepRecent: number;
  keepHourly: number;
  keepHourlyHours: number;
  keepSafety: number;
  maxPins: number;
  maxStoreMb: number;
  maxFileMb: number;
  maxFiles: number;
  settleMs: number;
  probeIntervalMs: number;
  probeSuccessCount: number;
  probeTimeoutMs: number;
  minSnapshotIntervalMs: number;
  includeEnv: boolean;
  overlaySignatures: string[];
}

export interface ManifestFile {
  path: string;
  type: FileType;
  sha256: string | null;
  mode: number;
  size: number;
  target: string | null;
}

export interface SkippedFile {
  path: string;
  reason:
    | "denylist"
    | "gitignore"
    | "localhostingignore"
    | "too_large"
    | "symlink_escape"
    | "unreadable";
  size: number | null;
}

export interface ManifestV1 {
  schema: "localhosting.snapshot.v1";
  id: string;
  created_at: string;
  last_seen_good_at: string;
  trigger: Trigger;
  confidence: Confidence;
  pinned: boolean;
  root: string;
  probe_url: string | null;
  probe_status: number | null;
  file_count: number;
  total_size: number;
  tree_hash: string;
  parent_id: string | null;
  files: ManifestFile[];
  skipped: SkippedFile[];
  skipped_truncated: boolean;
}

export interface SnapshotSummary {
  id: string;
  created_at: string;
  last_seen_good_at: string;
  trigger: Trigger;
  confidence: Confidence;
  pinned: boolean;
  file_count: number;
  total_size: number;
  tree_hash: string;
  delta: {
    added: number;
    changed: number;
    removed: number;
  } | null;
  age_ms: number;
}

export interface ListEnvelope {
  schema: "localhosting.list.v1";
  dir: string;
  snapshots: SnapshotSummary[];
}

export interface StatusEnvelope {
  schema: "localhosting.status.v1";
  dir: string;
  detector: DetectorState;
  probe: {
    url: string;
    last_status: number | null;
    last_overlay: boolean | null;
    last_error: string | null;
    last_at: string | null;
  };
  lock: { pid: number; started_at: string } | null;
  store: {
    snapshot_count: number;
    bytes_on_disk: number;
  };
  restore_journal_present: boolean;
  included_file_count_estimate: number | null;
}

export interface RestoreRequest {
  id: string;
  confirm: true;
  exact?: boolean;
}

export interface RestoreResponse {
  schema: "localhosting.restore.v1";
  ok: boolean;
  exit_code: 0 | 4 | 5;
  id: string;
  safety_id: string;
  overwritten: number;
  created: number;
  kept_extra: number;
  deleted_exact: number;
  locked_failed: Array<{ path: string; code: string }>;
  hint: "Restart your dev server. localhosting does not stop processes.";
}

export interface JournalLine {
  at: string;
  op: "commit" | "prune" | "restore_start" | "restore_end" | "pin" | "skip_dup";
  id: string | null;
  extra: Record<string, string | number | boolean | null>;
}

export interface LockFile {
  pid: number;
  started_at: string;
  dashboard: string;
}

export interface LastProbe {
  url: string;
  last_status: number | null;
  last_overlay: boolean | null;
  last_error: string | null;
  last_at: string | null;
}

export interface RestoreJournal {
  phase: "applying" | "done";
  target: string;
  safety_id: string;
  started_at: string;
}

export const RESTART_HINT =
  "Restart your dev server. localhosting does not stop processes." as const;
