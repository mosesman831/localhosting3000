import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { toRfc3339Z } from "../ids.js";
import { storeDir } from "../paths.js";
import type { JournalLine } from "../types.js";

export async function appendJournal(
  root: string,
  op: JournalLine["op"],
  id: string | null,
  extra: JournalLine["extra"] = {},
): Promise<void> {
  const dir = storeDir(root);
  await mkdir(dir, { recursive: true });
  const line: JournalLine = { at: toRfc3339Z(), op, id, extra };
  await appendFile(join(dir, "journal.jsonl"), JSON.stringify(line) + "\n", "utf8");
}
