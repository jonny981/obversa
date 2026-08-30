// The unattended path (an internal note): a router plugin resolves this
// package's public bin subpath — an exports entry naming the same file the
// bin field names — and spawns process.execPath with it, shell-free. The
// no-PATH promise is about finding and loading the bin, nothing wider
// (an internal note): a live review still takes git from the caller's
// environment, and the test below pins exactly where an empty-PATH launch
// stops — past resolution and loading, at the git spawn.

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

test("an empty-PATH launch fails at git, not at finding the command", () => {
  // The bin and its whole module graph loaded — the failure names the git
  // spawn the review needs, which the router's real environment carries.
  const resolved = fileURLToPath(import.meta.resolve("@obversa/source/bin"));
  const run = spawnSync(process.execPath, [resolved, "--no-open"], { encoding: "utf8", timeout: 15_000, env: { PATH: "" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /spawn git|git.*ENOENT/i, "the one missing piece is git from the environment");
});
