import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { writeErr } from "./io.js";
import { storeDir } from "./paths.js";
import type { ConfigV1 } from "./types.js";

export const DEFAULT_CONFIG: ConfigV1 = {
  schema: "localhosting.config.v1",
  url: "http://127.0.0.1:3000",
  probePath: "/",
  dashboardPort: 3001,
  bind: "127.0.0.1",
  keepRecent: 18,
  keepHourly: 6,
  keepHourlyHours: 12,
  keepSafety: 3,
  maxPins: 20,
  maxStoreMb: 1500,
  maxFileMb: 10,
  maxFiles: 10000,
  settleMs: 2500,
  probeIntervalMs: 500,
  probeSuccessCount: 4,
  probeTimeoutMs: 2000,
  minSnapshotIntervalMs: 20000,
  includeEnv: true,
  overlaySignatures: [],
};

const INT_FIELDS: Array<[keyof ConfigV1, number, number]> = [
  ["dashboardPort", 1, 65535],
  ["keepRecent", 1, 100],
  ["keepHourly", 0, 48],
  ["keepHourlyHours", 1, 72],
  ["keepSafety", 1, 20],
  ["maxPins", 1, 50],
  ["maxStoreMb", 50, 100000],
  ["maxFileMb", 1, 500],
  ["maxFiles", 10, 200000],
  ["settleMs", 200, 60000],
  ["probeIntervalMs", 100, 5000],
  ["probeSuccessCount", 2, 20],
  ["probeTimeoutMs", 200, 10000],
  ["minSnapshotIntervalMs", 5000, 600000],
];

const warnedUnknown = new Set<string>();

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function validateConfig(raw: Record<string, unknown>): ConfigV1 {
  const cfg: ConfigV1 = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONFIG)) {
      if (!warnedUnknown.has(key)) {
        warnedUnknown.add(key);
        writeErr(`localhosting: warning unknown config key ignored: ${key}`);
      }
    }
  }
  if (raw.schema !== undefined && raw.schema !== "localhosting.config.v1") {
    throw new CliError("E_USAGE", "invalid config schema");
  }
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string") throw new CliError("E_USAGE", "url must be a string");
    cfg.url = raw.url;
  }
  if (raw.probePath !== undefined) {
    if (typeof raw.probePath !== "string" || !raw.probePath.startsWith("/")) {
      throw new CliError("E_USAGE", "probePath must start with /");
    }
    cfg.probePath = raw.probePath;
  }
  if (raw.bind !== undefined && raw.bind !== "127.0.0.1") {
    throw new CliError("E_USAGE", "bind must be 127.0.0.1 in v1");
  }
  if (raw.includeEnv !== undefined) {
    if (typeof raw.includeEnv !== "boolean") {
      throw new CliError("E_USAGE", "includeEnv must be boolean");
    }
    cfg.includeEnv = raw.includeEnv;
  }
  if (raw.overlaySignatures !== undefined) {
    if (
      !Array.isArray(raw.overlaySignatures) ||
      raw.overlaySignatures.some((s) => typeof s !== "string")
    ) {
      throw new CliError("E_USAGE", "overlaySignatures must be string[]");
    }
    cfg.overlaySignatures = raw.overlaySignatures as string[];
  }
  for (const [field, min, max] of INT_FIELDS) {
    const v = raw[field];
    if (v === undefined) continue;
    if (!isInt(v) || v < min || v > max) {
      throw new CliError("E_USAGE", `${field} must be an integer ${min}-${max}`);
    }
    (cfg as unknown as Record<string, unknown>)[field] = v;
  }
  if (cfg.dashboardPort === 3000) {
    throw new CliError("E_PORT_3000", "dashboard must not bind port 3000");
  }
  return cfg;
}

export async function loadConfig(root: string): Promise<ConfigV1> {
  const path = join(storeDir(root), "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError("E_USAGE", "config.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliError("E_USAGE", "config.json must be an object");
  }
  return validateConfig(raw as Record<string, unknown>);
}

export async function writeDefaultConfig(root: string): Promise<void> {
  const dir = storeDir(root);
  await mkdir(join(dir, "objects", "sha256"), { recursive: true });
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await mkdir(join(dir, "staging"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  await mkdir(join(dir, "cache"), { recursive: true });
  const path = join(dir, "config.json");
  try {
    await readFile(path);
  } catch {
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  }
}

export async function ensureStore(root: string): Promise<void> {
  await writeDefaultConfig(root);
}
