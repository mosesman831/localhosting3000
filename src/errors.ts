export type ErrorCode =
  | "E_USAGE"
  | "E_ID"
  | "E_PORT_3000"
  | "E_URL"
  | "E_NOT_A_PROJECT"
  | "E_EMPTY_TREE"
  | "E_TREE_TOO_LARGE"
  | "E_HOME"
  | "E_DISK"
  | "E_CORRUPT"
  | "E_SAFETY"
  | "E_PARTIAL"
  | "E_ABORTED"
  | "E_LOCKED"
  | "E_BIND";

const EXIT: Record<ErrorCode, number> = {
  E_USAGE: 1,
  E_ID: 1,
  E_PORT_3000: 1,
  E_URL: 1,
  E_NOT_A_PROJECT: 2,
  E_EMPTY_TREE: 3,
  E_TREE_TOO_LARGE: 3,
  E_HOME: 3,
  E_DISK: 3,
  E_CORRUPT: 3,
  E_SAFETY: 3,
  E_PARTIAL: 4,
  E_ABORTED: 5,
  E_LOCKED: 6,
  E_BIND: 6,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = EXIT[code];
  }
}

export function formatStderr(code: ErrorCode, message: string): string {
  // Vibe layer: keep the spec-mandated `localhosting: <CODE> <message>` prefix
  // (so conformance regex assertions like /E_URL/ keep matching). A short
  // punchy one-liner is appended on a "why:" suffix line. No exit-code change,
  // no flag change, no JSON-shape change.
  return `localhosting: ${code} ${message}\n         why: ${errorOneLiner(code)}`;
}

// Local copy of the punchy lines. Inlined to avoid an import cycle between
// errors.ts <-> vibe.ts (errors.ts is imported by io helpers that vibe.ts
// itself imports). Single source of truth lives here.
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

function errorOneLiner(code: string): string {
  return PUNCHLINES[code] ?? "something went wrong.";
}

export function errorEnvelope(err: CliError): {
  schema: "localhosting.error.v1";
  ok: false;
  exit_code: number;
  code: ErrorCode;
  message: string;
} {
  return {
    schema: "localhosting.error.v1",
    ok: false,
    exit_code: err.exitCode,
    code: err.code,
    message: err.message,
  };
}
