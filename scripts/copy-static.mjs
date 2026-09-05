import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "dashboard", "static");
const to = join(root, "dist", "dashboard", "static");
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
