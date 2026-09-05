// Vibe layer: presentational flair only. No behavior changes, no flag renames,
// no error-code changes, no new exit codes, no JSON shape changes, no network.
//
// Everything here is gated on:
//   - non-JSON output mode (getIo().json is false)
//   - an attached TTY (avoids ANSI escapes in piped/Collect test output)
//
// Conformance TV-45 requires two runs of `prune --dry-run` to produce
// byte-identical stdout. To satisfy that, the banner must be DETERMINISTIC
// (no timestamps, no PIDs, no random bytes).

import type { Writable } from "node:stream";
import { getIo } from "./io.js";

// --- ANSI palette (only emitted when stdout/stderr is a TTY) -----------------
const ESC = "\x1b[";
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CYAN = `${Esc("36")}`;
const AGENT = `${Esc("38;5;213")}`;
const MAGENTA = `${Esc("35")}`;
const YELLOW = `${Esc("33")}`;
const RESET = `${Esc("0")}`;

function Esc(code: string): string {
  return `${ESC}${code}m`;
}

// --- ASCII banner -----------------------------------------------------------
// 57 columns. Pure ASCII. Safe for non-UTF8 locales and 100% deterministic.
const BANNER = [
  " _                                  _               _             ___",
  "| | ___  _ __   ___ _   _ _ __   ___| |__  _ __ ___ (_)_______  __|___ \\",
  "| |/ _ \\| '_ \\ / _ \\ | | | '_ \\ / __| '_ \\| '_ ` _ \\| |_  / _ \\/ __| __) |",
  "| | (_) | | | |  __/ |_| | | | | (__| | | | | | | | | |/ /  __/ (__ / __/",
  "|_|\\___/|_| |_|\\___|\\__, |_| |_|\\___|_| |_|_| |_| |_|_/___\\___|\\___|_____|",
  "                    |___/",
];

const TAGLINE = `${MAGENTA}the undo button for localhost${RESET}  ${DIM}vibes: 11${RESET}`;

export function bannerLines(): string[] {
  return [
    `${AGENT}${BANNER[0]}${RESET}`,
    `${AGENT}${BANNER[1]}${RESET}`,
    `${AGENT}${BANNER[2]}${RESET}`,
    `${AGENT}${BANNER[3]}${RESET}`,
    `${AGENT}${BANNER[4]}${RESET}`,
    `${AGENT}${BANNER[5]}${RESET}`,
    `  ${TAGLINE}`,
    "",
  ];
}

function tty(stream: Writable): boolean {
  // tests pass a PassThrough; real terminals expose isTTY=true
  return (stream as { isTTY?: boolean }).isTTY === true;
}

export function printBanner(): void {
  const io = getIo();
  if (io.json) return;
  if (!tty(io.stdout)) return;
  for (const line of bannerLines()) {
    io.stdout.write(line + "\n");
  }
}

// --- Punchy one-liner appended to every error --------------------------------
// Pure ASCII (no emoji in errors; CLI errors get copy). The error CODE prefix
// (E_URL, E_HOME, ...) remains untouched so the conformance regex `match`
// passes still find it.
const PUNCHLINES: Record<string, string> = {
  E_USAGE: "wrong door. try --help.",
  E_ID: "no such snapshot. list first.",
  E_PORT_3000: "3000 is for your app. pick anything else.",
  E_URL: "loopback only. we don't do that here.",
  E_NOT_A_PROJECT: "no .localhosting here. run `localhosting init` first.",
  E_EMPTY_TREE: "nothing to save. write something, then ask again.",
  E_TREE_TOO_LARGE: "calm down. that's a lot of files.",
  E_HOME: "refusing to crawl $HOME. pick a real project.",
  E_DISK: "disk said no. blame the disk.",
  E_CORRUPT: "snapshot bytes don't match the hash. tampered or broken.",
  E_SAFETY: "safety first: pre-restore snapshot failed. aborting.",
  E_PARTIAL: "some files were locked. the rest got restored.",
  E_ABORTED: "you didn't type RESTORE. file lives another day.",
  E_LOCKED: "another watcher owns this. kill it or wait.",
  E_BIND: "couldn't bind the dashboard port. pick another.",
  E_STORE_OVER_CAP: "store is fat. prune something.",
};

export function errorOneLiner(code: string): string {
  return PUNCHLINES[code] ?? "something went wrong.";
}

// --- Emoji-flavored success helpers -----------------------------------------
const EMOJI = {
  camera: "📸",
  party: "🎉",
  pin: "📌",
  unpin: "🪧",
  list: "📜",
  prune: "🧹",
  restore: "⏪",
  status: "🛰️",
  init: "🌱",
  watch: "👀",
  serve: "🖥️",
};

export function vibeFor(command: string): string {
  const k = command as keyof typeof EMOJI;
  return EMOJI[k] ?? "✨";
}

// --- ASCII progress bar -----------------------------------------------------
// width characters total, filled `pct` (0..100). Pure ASCII.
export function progressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "█".repeat(filled) + "·".repeat(width - filled) + `] ${clamped}%`;
}

// --- "Help tagline" prefix for subcommand descriptions ----------------------
// The actual subcommand description remains accurate; we prefix a vibe line.
export const HelpTag: Record<string, string> = {
  init: "init - plant the flag (or the .localhosting folder, same thing).",
  watch: "watch - the main character. snapshots on good builds.",
  serve: "serve - dashboard only. for the read-only crowd.",
  snapshot: "snapshot - take one now. you know it's good.",
  list: "list - show off your saves (or your mistakes, we don't judge).",
  restore: "restore - revert like it never happened. safety snap first.",
  pin: "pin - keep this one forever-ish (cap 20).",
  unpin: "unpin - let go. prune may delete this.",
  prune: "prune - clean house. pinned survives, the rest is negotiable.",
  status: "status - what's the watch doing, where's the store.",
};

// --- Color helpers (kept tiny; no chalk dep) -------------------------------
export function color(text: string, c: "cyan" | "yellow" | "magenta" | "dim"): string {
  const io = getIo();
  if (!tty(io.stdout)) return text;
  switch (c) {
    case "cyan":
      return `${CYAN}${text}${RESET}`;
    case "yellow":
      return `${YELLOW}${text}${RESET}`;
    case "magenta":
      return `${MAGENTA}${text}${RESET}`;
    case "dim":
      return `${DIM}${text}${RESET}`;
  }
}

export const ANSI = { DIM, BOLD, CYAN, AGENT, MAGENTA, YELLOW, RESET };