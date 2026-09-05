import { getIo, writeJson, writeOut } from "../io.js";
import { storeDir } from "../paths.js";
import { existsSync } from "node:fs";
import { CliError } from "../errors.js";
import { buildListEnvelope } from "../dashboard/listen.js";
import { formatAgeShort, formatDelta } from "../format.js";

export async function cmdList(root: string): Promise<void> {
  if (!existsSync(storeDir(root))) {
    throw new CliError("E_NOT_A_PROJECT", "no .localhosting store");
  }
  const env = await buildListEnvelope(root);
  if (getIo().json) {
    writeJson(env);
    return;
  }
  writeOut(
    "ID                               AGE      TRIGGER      CONF            FILES   SIZE     DELTA     PIN",
  );
  for (const s of env.snapshots) {
    const pin = s.pinned ? "*" : ".";
    const line = [
      s.id.padEnd(32),
      formatAgeShort(s.age_ms).padEnd(8),
      s.trigger.padEnd(12),
      s.confidence.padEnd(15),
      String(s.file_count).padEnd(7),
      String(s.total_size).padEnd(8),
      formatDelta(s.delta).padEnd(9),
      pin,
    ].join(" ");
    writeOut(line);
  }
}
