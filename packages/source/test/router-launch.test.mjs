// The unattended path (an internal note): a router plugin resolves this
// package's public bin subpath — an exports entry naming the same file the
// bin field names — and spawns process.execPath with it, shell-free, with no
// PATH at all. npx is a person's convenience; the router never needs it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the bin subpath resolves to the file the bin field names, and runs with an empty PATH", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const resolved = fileURLToPath(import.meta.resolve("@obversa/source/bin"));
  assert.ok(resolved.endsWith(manifest.bin["obversa-review"].slice(1)), `${resolved} is the bin field's file`);

  const help = spawnSync(process.execPath, [resolved, "--help"], { encoding: "utf8", timeout: 10_000, env: { PATH: "" } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/, "the command loads and answers from the resolved file alone");

  const bad = spawnSync(process.execPath, [resolved, "--cwd"], { encoding: "utf8", timeout: 10_000, env: { PATH: "" } });
  assert.equal(bad.status, 2, "a usage error still exits 2 with no PATH");
  assert.equal(bad.stdout, "");
});
