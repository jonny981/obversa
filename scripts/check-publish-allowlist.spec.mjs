import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOOK_COMMAND, audit, checkHook, listWorkspacePackages, releaseTagFor } from "./check-publish-allowlist.mjs";

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

test("releaseTagFor names exactly one package and version", () => {
  assert.equal(releaseTagFor("@obversa/lines", "1.0.0"), "obversa-lines@1.0.0");
  assert.equal(releaseTagFor("@obversa/memory-git", "0.1.0"), "obversa-memory-git@0.1.0");
  assert.equal(releaseTagFor("@obversa/engine-claude-cli", "0.1.0"), "obversa-engine-claude-cli@0.1.0");
});

// A git repository around one workspace package, so the hook's release-record
// checks (branch, clean tree, annotated tag) run against the real thing.
function makeReleaseRepo() {
  const root = makeWorkspace({ "packages/p": { name: "@x/p", version: "1.0.0" } });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { root, cwd: path.join(root, "packages", "p"), git };
}

test("the prepublishOnly hook refuses without the release flag or the allowlist entry", () => {
  const { root, cwd } = makeReleaseRepo();
  try {
    const allowlist = new Set(["@x/p"]);
    assert.match(checkHook({ cwd, env: {}, allowlist }).join("\n"), /OBVERSA_RELEASE=1 is not set/);
    assert.match(checkHook({ cwd, env: { OBVERSA_RELEASE: "1" }, allowlist: new Set() }).join("\n"), /not on scripts\/publish-allowlist\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the hook requires the release record: main, a clean tree, and this package's annotated tag at HEAD", () => {
  const { root, cwd, git } = makeReleaseRepo();
  try {
    const allowlist = new Set(["@x/p"]);
    const env = { OBVERSA_RELEASE: "1" };
    const problems = () => checkHook({ cwd, env, allowlist }).join("\n");
    // No tag yet.
    assert.match(problems(), /HEAD is not tagged x-p@1\.0\.0/);
    // A lightweight tag is not a record.
    git("tag", "x-p@1.0.0");
    assert.match(problems(), /must be an annotated tag/);
    git("tag", "-d", "x-p@1.0.0");
    // A sibling's tag, or the same version on another package, does not count.
    git("tag", "-a", "-m", "release", "x-other@1.0.0");
    assert.match(problems(), /HEAD is not tagged x-p@1\.0\.0/);
    // The right annotated tag on main with a clean tree: allowed.
    git("tag", "-a", "-m", "release @x/p 1.0.0", "x-p@1.0.0");
    assert.deepEqual(checkHook({ cwd, env, allowlist }), []);
    // A dirty tree is refused even with the tag in place.
    writeFileSync(path.join(cwd, "scratch.txt"), "wip\n");
    assert.match(problems(), /working tree is not clean/);
    rmSync(path.join(cwd, "scratch.txt"));
    // Off main is refused even with the tag in place.
    git("checkout", "-q", "-b", "feature");
    assert.match(problems(), /releases publish from main \(checkout is on feature\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a git repository the hook refuses", () => {
  const root = makeWorkspace({ "packages/p": { name: "@x/p", version: "1.0.0" } });
  try {
    const problems = checkHook({ cwd: path.join(root, "packages", "p"), env: { OBVERSA_RELEASE: "1" }, allowlist: new Set(["@x/p"]), run: () => { throw new Error("no git"); } });
    assert.match(problems.join("\n"), /not inside a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
