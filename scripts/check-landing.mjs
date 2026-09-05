import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "landing", "index.html"), "utf8");
const css = readFileSync(join(root, "landing", "styles.css"), "utf8");

const need = ["localhosting:3000", "npx localhosting watch", "Why not just use git?"];
for (const s of need) {
  if (!html.includes(s)) {
    console.error("landing missing:", s);
    process.exit(1);
  }
}
if (/lorem/i.test(html) || html.includes("Coming soon") || html.includes("TODO")) {
  console.error("landing contains forbidden copy");
  process.exit(1);
}
if (html.includes("127.0.0.1") && html.includes("<iframe")) {
  console.error("landing iframe to loopback");
  process.exit(1);
}
if (!html.includes('name="viewport"')) {
  console.error("missing viewport");
  process.exit(1);
}
if ((html.match(/class="marquee"/g) || []).length !== 1) {
  console.error("need exactly one marquee");
  process.exit(1);
}
void css;
console.log("landing check ok");
