import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const landing = join(root, "landing");

test("TV-61 built landing has H1 and CTA", async () => {
  const html = await readFile(join(landing, "index.html"), "utf8");
  assert.match(html, /<h1>localhosting:3000<\/h1>/);
  assert.match(html, /npx localhosting watch/);
});

test("TV-62 no lorem, Coming soon, or TODO", async () => {
  const html = await readFile(join(landing, "index.html"), "utf8");
  const css = await readFile(join(landing, "styles.css"), "utf8");
  const js = await readFile(join(landing, "main.js"), "utf8");
  const all = html + css + js;
  assert.equal(/lorem/i.test(all), false);
  assert.equal(all.includes("Coming soon"), false);
  assert.equal(all.includes("TODO"), false);
});

test("TV-64 exactly one marquee and FAQ git question", async () => {
  const html = await readFile(join(landing, "index.html"), "utf8");
  const n = (html.match(/class="marquee"/g) || []).length;
  assert.equal(n, 1);
  assert.match(html, /Why not just use git\?/);
});

test("TV-65 no iframe to 127.0.0.1", async () => {
  const html = await readFile(join(landing, "index.html"), "utf8");
  assert.equal(/<iframe[^>]*127\.0\.0\.1/i.test(html), false);
});
