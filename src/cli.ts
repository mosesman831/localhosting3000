#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { cmdInit } from "./commands/init.js";
import { cmdList } from "./commands/list.js";
import { cmdPin } from "./commands/pin.js";
import { cmdPrune } from "./commands/prune.js";
import { cmdRestore } from "./commands/restore.js";
import { cmdServe } from "./commands/serve.js";
import { cmdSnapshot } from "./commands/snapshot.js";
import { cmdStatus } from "./commands/status.js";
import { cmdWatch } from "./commands/watch.js";
import { CliError, errorEnvelope, formatStderr } from "./errors.js";
import { defaultIo, getIo, runWithIo, writeErr, writeJson, type Io } from "./io.js";
import { printBanner, HelpTag } from "./vibe.js";

const require = createRequire(import.meta.url);

function pkgVersion(): string {
  try {
    const pkg = require("../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.1.0";
  }
}

export interface RunOptions {
  io?: Partial<Io>;
  signal?: AbortSignal;
  argv?: string[];
}

export async function run(argv: string[] = process.argv.slice(2), opts: RunOptions = {}): Promise<number> {
  const base = defaultIo();
  const io: Io = { ...base, ...opts.io };
  return await runWithIo(io, () => runInner(argv, opts.signal));
}

async function runInner(argv: string[], signal?: AbortSignal): Promise<number> {
  const program = new Command();
  program.name("localhosting");
  program.description(
    "Undo button for localhost. Automatic snapshots when your local app is actually serving a good state. Not git. Not Vercel rollback. Not a port killer.",
  );
  // Vibe layer: print a custom version banner for `--version` instead of
  // commander's default one-liner. We do this by intercepting argv BEFORE
  // commander parses (so we work even without a subcommand). Spec requires
  // the version + "vibes: 11" tagline; no other behavior change.
  const ver = pkgVersion();
  if (argv.includes("-V") || argv.includes("--version")) {
    const io = getIo();
    io.stdout.write(`${ver}\n`);
    io.stdout.write("vibes: 11\n");
    return 0;
  }
  program.option("-V, --version", "output the version number");
  program.hook("preAction", () => {
    // Otherwise, print the banner before every command action. Skip JSON
    // mode (machine-readable) and skip when stdout isn't a TTY (piped output
    // and test Collect streams), so conformance tests stay byte-stable.
    printBanner();
  });

  // Vibe layer: append a tagline line to each subcommand's --help output.
  // addHelpText("after") inserts content after the existing help text.
  // The spec-mandated flag/option info remains unchanged; only a decorative
  // line is added below the description.
  function tag(command: Command, name: keyof typeof HelpTag): void {
    command.addHelpText("after", `\n${HelpTag[name]}\n`);
  }
  program.option("--dir <path>", "project root", process.cwd());
  program.option("--json", "JSON on stdout", false);
  program.option("--yes", "noninteractive confirm", false);
  program.helpOption("-h, --help");
  program.showHelpAfterError(false);
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => getIo().stdout.write(s),
    writeErr: (s) => getIo().stderr.write(s),
  });

  async function rootOf(cmd: Command): Promise<string> {
    const g = cmd.optsWithGlobals() as { dir?: string; json?: boolean; yes?: boolean };
    const io = getIo();
    io.json = !!g.json;
    io.yes = !!g.yes;
    const dir = resolve(g.dir || io.dir || process.cwd());
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) throw new CliError("E_USAGE", " --dir is not a directory");
      return await realpath(dir);
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError("E_USAGE", `directory not found: ${dir}`);
    }
  }

  program
    .command("init")
    .description("Create .localhosting/ store and gitignore line")
    .action(async (_opts, cmd: Command) => {
      await cmdInit(await rootOf(cmd));
    });
  tag(program.commands.find((c) => c.name() === "init")!, "init");

  program
    .command("watch")
    .description("Watch for good-state snapshots and serve the dashboard")
    .option("--url <url>", "probe origin")
    .option("--probe-path <path>", "probe path")
    .option("--dashboard-port <n>", "dashboard port", (v: string) => Number(v))
    .option("--no-include-env", "do not include .env* files")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const root = await rootOf(cmd);
      const port = opts.dashboardPort as number | undefined;
      if (port === 3000) throw new CliError("E_PORT_3000", "dashboard must not bind port 3000");
      await cmdWatch(root, {
        url: opts.url as string | undefined,
        probePath: opts.probePath as string | undefined,
        dashboardPort: port,
        includeEnv: opts.includeEnv as boolean | undefined,
        signal,
      });
    });
  tag(program.commands.find((c) => c.name() === "watch")!, "watch");

  program
    .command("serve")
    .description("Dashboard only (no auto snapshots)")
    .option("--dashboard-port <n>", "dashboard port", (v: string) => Number(v))
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const root = await rootOf(cmd);
      const port = opts.dashboardPort as number | undefined;
      if (port === 3000) throw new CliError("E_PORT_3000", "dashboard must not bind port 3000");
      await cmdServe(root, { dashboardPort: port, signal });
    });
  tag(program.commands.find((c) => c.name() === "serve")!, "serve");

  program
    .command("snapshot")
    .description("Manual snapshot now")
    .option("--pin", "pin after commit", false)
    .action(async (opts: { pin?: boolean }, cmd: Command) => {
      await cmdSnapshot(await rootOf(cmd), { pin: !!opts.pin });
    });
  tag(program.commands.find((c) => c.name() === "snapshot")!, "snapshot");

  program
    .command("list")
    .description("List snapshots newest first")
    .action(async (_opts, cmd: Command) => {
      await cmdList(await rootOf(cmd));
    });
  tag(program.commands.find((c) => c.name() === "list")!, "list");

  program
    .command("restore")
    .argument("<id>", "snapshot id or unique prefix")
    .description("Restore a snapshot (safety snapshot first)")
    .option("--exact", "delete extras not in the snapshot", false)
    .option("--dry-run", "print plan only", false)
    .action(async (id: string, opts: { exact?: boolean; dryRun?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { yes?: boolean };
      const code = await cmdRestore(await rootOf(cmd), id, {
        exact: !!opts.exact,
        dryRun: !!opts.dryRun,
        yes: !!g.yes,
      });
      if (code === 4) {
        throw new CliError("E_PARTIAL", "some files were locked");
      }
      if (code !== 0) {
        throw new CliError("E_USAGE", "restore finished with errors");
      }
    });
  tag(program.commands.find((c) => c.name() === "restore")!, "restore");

  program
    .command("pin")
    .argument("<id>", "snapshot id")
    .description("Pin a snapshot")
    .option("--force-pin", "unpin oldest pin if at cap", false)
    .action(async (id: string, opts: { forcePin?: boolean }, cmd: Command) => {
      await cmdPin(await rootOf(cmd), id, { forcePin: !!opts.forcePin, pinned: true });
    });
  tag(program.commands.find((c) => c.name() === "pin")!, "pin");

  program
    .command("unpin")
    .argument("<id>", "snapshot id")
    .description("Unpin a snapshot")
    .action(async (id: string, _opts, cmd: Command) => {
      await cmdPin(await rootOf(cmd), id, { pinned: false });
    });
  tag(program.commands.find((c) => c.name() === "unpin")!, "unpin");

  program
    .command("prune")
    .description("Run retention prune")
    .option("--dry-run", "list ids that would be deleted", false)
    .action(async (opts: { dryRun?: boolean }, cmd: Command) => {
      await cmdPrune(await rootOf(cmd), { dryRun: !!opts.dryRun });
    });
  tag(program.commands.find((c) => c.name() === "prune")!, "prune");

  program
    .command("status")
    .description("Show detector and store status")
    .action(async (_opts, cmd: Command) => {
      await cmdStatus(await rootOf(cmd));
    });
  tag(program.commands.find((c) => c.name() === "status")!, "status");

  try {
    await program.parseAsync(["node", "localhosting", ...argv]);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        return 0;
      }
      if (err.code === "commander.unknownCommand") {
        writeErr("unknown command");
        if (getIo().json) {
          writeJson(
            errorEnvelope(new CliError("E_USAGE", "unknown command")),
          );
        }
        return 1;
      }
      const ce = new CliError("E_USAGE", err.message);
      writeErr(formatStderr(ce.code, ce.message));
      if (getIo().json) writeJson(errorEnvelope(ce));
      return 1;
    }
    if (err instanceof CliError) {
      writeErr(formatStderr(err.code, err.message));
      if (getIo().json) writeJson(errorEnvelope(err));
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    const ce = new CliError("E_USAGE", message);
    writeErr(formatStderr(ce.code, ce.message));
    if (getIo().json) writeJson(errorEnvelope(ce));
    return 1;
  }
}

const isDirect =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("cli.ts") ||
    process.argv[1].includes("/cli."));

if (isDirect) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
