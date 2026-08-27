import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOOK_COMMAND, audit, checkHook, listWorkspacePackages } from "./check-publish-allowlist.mjs";

function makeWorkspace(packages) {
  const root = mkdtempSync(path.join(os.tmpdir(), "publish-guard-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - plugins/*\n");
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

test("the live workspace passes the audit against the live allowlist", () => {
  assert.deepEqual(audit(), []);
});

test("listWorkspacePackages follows every dir/* glob in pnpm-workspace.yaml", () => {
  const root = makeWorkspace({
    "packages/a": { name: "@x/a" },
    "plugins/b": { name: "@x/b", private: true },
  });
  try {
    const names = listWorkspacePackages(root).map((p) => `${p.name}:${p.private}`).sort();
    assert.deepEqual(names, ["@x/a:false", "@x/b:true"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const HOOKED = { prepublishOnly: HOOK_COMMAND };

test("the audit fails closed: an unlisted public package, a missing or wrong hook, a listed private one, and a listed ghost", () => {
  const root = makeWorkspace({
    "packages/pub": { name: "@x/pub", scripts: HOOKED },
    "packages/nohook": { name: "@x/nohook", scripts: { build: "tsup" } },
    // Lookalikes that mention the script but do not run the guard.
    "packages/echo": { name: "@x/echo", scripts: { prepublishOnly: "echo check-publish-allowlist.mjs" } },
    "packages/audit": { name: "@x/audit", scripts: { prepublishOnly: "node ../../scripts/check-publish-allowlist.mjs --audit" } },
    "packages/priv": { name: "@x/priv", private: true },
    "packages/ok": { name: "@x/ok", scripts: HOOKED },
  });
  try {
    const problems = audit({ root, allowlist: new Set(["@x/ok", "@x/nohook", "@x/echo", "@x/audit", "@x/priv", "@x/ghost"]) });
    const text = problems.join("\n");
    assert.equal(problems.length, 6, text);
    assert.match(text, /@x\/pub .* not on the allowlist/);
    assert.match(text, /@x\/nohook .*prepublishOnly is not exactly/);
    assert.match(text, /@x\/echo .*prepublishOnly is not exactly/);
    assert.match(text, /@x\/audit .*prepublishOnly is not exactly/);
    assert.match(text, /@x\/priv .* marked private/);
    assert.match(text, /@x\/ghost .* not a workspace package/);
    // A private package needs no hook; the exact hook raises nothing.
    assert.doesNotMatch(text, /@x\/priv .* prepublishOnly/);
    assert.doesNotMatch(text, /@x\/ok /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the prepublishOnly hook refuses without the release flag or the allowlist entry", () => {
  const root = makeWorkspace({ "packages/p": { name: "@x/p" } });
  const cwd = path.join(root, "packages", "p");
  try {
    const allowlist = new Set(["@x/p"]);
    assert.match(checkHook({ cwd, env: {}, allowlist }).join("\n"), /OBVERSA_RELEASE=1 is not set/);
    assert.match(checkHook({ cwd, env: { OBVERSA_RELEASE: "1" }, allowlist: new Set() }).join("\n"), /not on scripts\/publish-allowlist\.json/);
    assert.deepEqual(checkHook({ cwd, env: { OBVERSA_RELEASE: "1" }, allowlist }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
