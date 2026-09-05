import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureStore } from "../config.js";
import { writeOut } from "../io.js";
import { storeDir } from "../paths.js";
import { vibeFor } from "../vibe.js";

export async function cmdInit(root: string): Promise<void> {
  await ensureStore(root);
  const gi = join(root, ".gitignore");
  let gitignore: "updated" | "ok" = "ok";
  let existing = "";
  try {
    existing = await readFile(gi, "utf8");
  } catch {
    existing = "";
  }
  const hasLine = existing.split(/\r?\n/).some((l) => l.trim() === ".localhosting/");
  if (!hasLine) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    if (existing.length === 0) {
      await writeFile(gi, ".localhosting/\n", "utf8");
    } else {
      await appendFile(gi, `${prefix}.localhosting/\n`, "utf8");
    }
    gitignore = "updated";
  }
  // Vibe layer: lead with a fun welcome line, then the spec-mandated lines.
  // Spec preserves: store path is printed on stdout, gitignore outcome is
  // printed on stdout. We just add a one-line welcome above.
  writeOut(`localhosting:3000 - watching your back ${vibeFor("init")}`);
  writeOut(`root: ${root}`);
  writeOut(`store: ${storeDir(root)}`);
  writeOut(`gitignore: ${gitignore}`);
}
