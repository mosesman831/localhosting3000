import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { cli, makeProject, rmrf } from "./helpers.js";
import { assertNoPostinstall } from "../src/net/guard.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { scripts?: Record<string, string> };

test("TV-60 package has no postinstall script", () => {
  assert.equal(assertNoPostinstall(pkg), true);
  assert.equal(pkg.scripts && "postinstall" in pkg.scripts, false);
});

test("TV-59 snapshot makes zero fetch/http connections", async () => {
  const dir = await makeProject();
  const hosts: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    hosts.push(new URL(url).hostname);
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const r = await cli(["snapshot"], { dir, yes: true });
    assert.equal(r.code, 0);
    assert.deepEqual(hosts, []);
  } finally {
    globalThis.fetch = origFetch;
    await rmrf(dir);
  }
  void join;
});
