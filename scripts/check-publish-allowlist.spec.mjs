import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOOK_COMMAND, PUBLISH_REGISTRY_SENTINEL, SCOPE_REGISTRY_KEY, audit, checkHook, listWorkspacePackages, releaseTagFor } from "./check-publish-allowlist.mjs";
import { publishArgs, release, releasePlan, runChild } from "./release.mjs";

// Both registry keys npm consults for a scoped name, pinned to the sentinel.
const SENTINELS = { registry: PUBLISH_REGISTRY_SENTINEL, [SCOPE_REGISTRY_KEY]: PUBLISH_REGISTRY_SENTINEL };

function makeWorkspace(packages, { rootManifest = { name: "workspace", private: true } } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "publish-guard-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - plugins/*\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify(rootManifest));
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
  const guarded = { publishConfig: { ...SENTINELS } };
  const root = makeWorkspace({
    "packages/pub": { name: "@x/pub", scripts: HOOKED, ...guarded },
    "packages/nohook": { name: "@x/nohook", scripts: { build: "tsup" }, ...guarded },
    // Lookalikes that mention the script but do not run the guard.
    "packages/echo": { name: "@x/echo", scripts: { prepublishOnly: "echo check-publish-allowlist.mjs" }, ...guarded },
    "packages/audit": { name: "@x/audit", scripts: { prepublishOnly: "node ../../scripts/check-publish-allowlist.mjs --audit" }, ...guarded },
    "packages/priv": { name: "@x/priv", private: true },
    "packages/ok": { name: "@x/ok", scripts: HOOKED, ...guarded },
  });
  try {
    const problems = audit({ root, allowlist: new Set(["@x/ok", "@x/nohook", "@x/echo", "@x/audit", "@x/priv", "@x/ghost"]) });
    const text = problems.join("\n");
    // Six package problems, and the fixture has no release command.
    assert.equal(problems.length, 7, text);
    assert.match(text, /release\.mjs is missing/);
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

test("the audit requires every public package to name the never-resolving registry under both keys, no other registry route, no publish directory, and the release command to exist", () => {
  const good = { name: "@obversa/pub", version: "1.0.0", scripts: { prepublishOnly: HOOK_COMMAND }, publishConfig: { access: "public", ...SENTINELS } };
  const root = makeWorkspace({
    "packages/pub": good,
    "packages/real": { ...good, name: "@obversa/real", publishConfig: { access: "public", registry: "https://registry.npmjs.org/", [SCOPE_REGISTRY_KEY]: PUBLISH_REGISTRY_SENTINEL } },
    "packages/bare": { ...good, name: "@obversa/bare", publishConfig: { access: "public" } },
    // The plain sentinel with a scoped real registry: npm picks the scope key
    // first, so this manifest would publish for real.
    "packages/scoped": { ...good, name: "@obversa/scoped", publishConfig: { access: "public", registry: PUBLISH_REGISTRY_SENTINEL, [SCOPE_REGISTRY_KEY]: "https://registry.npmjs.org/" } },
    "packages/noscope": { ...good, name: "@obversa/noscope", publishConfig: { access: "public", registry: PUBLISH_REGISTRY_SENTINEL } },
    "packages/other": { ...good, name: "@obversa/other", publishConfig: { access: "public", ...SENTINELS, "@elsewhere:registry": "https://registry.npmjs.org/" } },
    "packages/nested": { ...good, name: "@obversa/nested", publishConfig: { access: "public", ...SENTINELS, directory: "dist" } },
    "packages/priv": { name: "@obversa/priv", private: true, publishConfig: { access: "public" } },
  });
  try {
    const problems = audit({ root, allowlist: new Set(["@obversa/pub", "@obversa/real", "@obversa/bare", "@obversa/scoped", "@obversa/noscope", "@obversa/other", "@obversa/nested"]) });
    assert.ok(problems.some((p) => p.startsWith("@obversa/real ") && p.includes("publishConfig.registry")), "a real registry in a manifest is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/bare ") && p.includes("publishConfig.registry")), "no registry means the default, the real one");
    assert.ok(problems.some((p) => p.startsWith("@obversa/scoped ") && p.includes(`publishConfig["${SCOPE_REGISTRY_KEY}"]`)), "a scoped real registry beside the plain sentinel is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/noscope ") && p.includes(`publishConfig["${SCOPE_REGISTRY_KEY}"]`)), "the scope key must be the sentinel too, or a standing user config supplies a real one");
    assert.ok(problems.some((p) => p.startsWith("@obversa/other ") && p.includes("@elsewhere:registry")), "any other registry route is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/nested ") && p.includes("publishConfig.directory")), "a publish directory hides a manifest the audit does not read");
    assert.ok(!problems.some((p) => p.startsWith("@obversa/pub ")), "both sentinels pass");
    assert.ok(!problems.some((p) => p.startsWith("@obversa/priv ")), "a private package is not held to it");
    assert.ok(problems.some((p) => p.includes("release.mjs is missing")), "the fixture has no release command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the audit pins the workspace root private, so a version on it cannot make one more publishable manifest", () => {
  const pkg = { name: "@obversa/pub", version: "1.0.0", scripts: { prepublishOnly: HOOK_COMMAND }, publishConfig: { access: "public", ...SENTINELS } };
  const publicRoot = makeWorkspace({ "packages/pub": pkg }, { rootManifest: { name: "obversa", version: "1.0.0" } });
  const privateRoot = makeWorkspace({ "packages/pub": pkg });
  try {
    assert.ok(audit({ root: publicRoot, allowlist: new Set(["@obversa/pub"]) }).some((p) => /workspace root package\.json must be "private": true/.test(p)));
    assert.ok(!audit({ root: privateRoot, allowlist: new Set(["@obversa/pub"]) }).some((p) => /workspace root/.test(p)));
  } finally {
    rmSync(publicRoot, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the release plan publishes exactly one listed public package directory, after the guard", () => {
  const root = makeWorkspace({
    "packages/pub": { name: "@x/pub", version: "1.0.0", scripts: HOOKED, publishConfig: { access: "public", ...SENTINELS } },
    "packages/priv": { name: "@x/priv", private: true },
  });
  try {
    const packages = listWorkspacePackages(root);
    const calls = [];
    const check = ({ cwd }) => { calls.push(cwd); return []; };
    const plan = releasePlan({ target: "packages/pub", root, packages, check });
    assert.equal(plan.name, "@x/pub");
    assert.deepEqual(plan.pack, { command: "pnpm", args: ["pack", "--pack-destination"] }, "pnpm packs, so workspace versions are rewritten");
    assert.deepEqual(plan.publishArgs("/tmp/x.tgz"), ["publish", "/tmp/x.tgz", "--registry", "https://registry.npmjs.org/", `--${SCOPE_REGISTRY_KEY}=https://registry.npmjs.org/`, "--access", "public"], "npm publishes the tarball with both registry keys overridden as flags");
    assert.deepEqual(calls, [plan.cwd], "the guard ran on that directory first");
    assert.deepEqual(releasePlan({ target: "packages/pub", flags: ["--dry-run"], root, packages, check }).publishArgs("/tmp/x.tgz").at(-1), "--dry-run");
    for (const bad of ["packages/priv", "packages/nothere", "packages/pub/..", "..", "/tmp", "hosts/cmux", "packages/pub/src"]) {
      assert.throws(() => releasePlan({ target: bad, root, packages, check }), /not the directory of a public workspace package/, bad);
    }
    assert.throws(() => releasePlan({ target: "packages/pub", flags: ["--force"], root, packages, check }), /unknown flag --force/);
    assert.throws(() => releasePlan({ target: "packages/pub", root, packages, check: () => ["no tag"] }), /release: no tag/, "the guard's refusal is the plan's refusal");
    assert.throws(() => releasePlan({ target: "", root, packages, check }), /usage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packed tarball carries the never-resolving registry, so publishing it — which runs no hook — goes nowhere", { timeout: 120_000 }, () => {
  // The seatbelt as it travels: the manifest inside the tarball names the
  // sentinel registry, which is what `npm publish x.tgz` would use, and no
  // hook runs at pack time either. No form of `npm publish` is invoked here
  // — even a dry run does registry work — since a tarball publish skipping
  // prepublishOnly is npm's documented behaviour, confirmed once against a
  // loopback registry, not something this suite re-proves.
  const root = mkdtempSync(path.join(os.tmpdir(), "publish-tarball-"));
  try {
    const pkg = path.join(root, "pkg");
    mkdirSync(pkg);
    writeFileSync(path.join(pkg, "index.js"), "module.exports = 1;\n");
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
      name: "@obversa-test/tarball-guard",
      version: "0.0.1",
      main: "index.js",
      scripts: { prepublishOnly: "node -e \"require('fs').writeFileSync('HOOK_RAN', '')\"" },
      publishConfig: { access: "public", registry: PUBLISH_REGISTRY_SENTINEL },
    }));
    const env = { ...process.env, npm_config_update_notifier: "false" };
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: pkg, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const tarball = path.join(root, "obversa-test-tarball-guard-0.0.1.tgz");
    rmSync(path.join(pkg, "HOOK_RAN"), { force: true });
    const packed = JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
    assert.equal(packed.publishConfig?.registry, PUBLISH_REGISTRY_SENTINEL, "the registry inside the tarball is the sentinel");
    assert.doesNotMatch(JSON.stringify(packed), /registry\.npmjs\.org/, "the real registry appears nowhere in it");
    assert.equal(existsSync(path.join(pkg, "HOOK_RAN")), false, "no hook ran at pack time");
    assert.equal(existsSync(path.join(root, "HOOK_RAN")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The npm this machine publishes with, by its own location: its bundled
// registry picker and its publish command are the rules the seatbelt is
// built on, read in-process — no publish subcommand, no socket.
const NPM_DIR = path.join(execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(), "lib", "node_modules", "npm");

test("npm's registry precedence, from npm's own code: the scope key beats registry, and the publish command lets a CLI flag beat publishConfig", async () => {
  const npmVersion = JSON.parse(readFileSync(path.join(NPM_DIR, "package.json"), "utf8")).version;
  assert.match(npmVersion, /^10\./, `the rules below were read from npm ${npmVersion}`);
  const { pickRegistry } = createRequire(import.meta.url)(path.join(NPM_DIR, "node_modules", "npm-registry-fetch"));
  const loopback = "http://127.0.0.1:9/";
  // A manifest's two sentinels with a plain override: the scope key wins,
  // so the publish would go to the sentinel and fail.
  assert.equal(pickRegistry("@obversa/x", { registry: loopback, [SCOPE_REGISTRY_KEY]: PUBLISH_REGISTRY_SENTINEL }), PUBLISH_REGISTRY_SENTINEL);
  // Only the plain sentinel, with a scoped real registry beside it (a manifest
  // or a standing user config): the real one wins — the route the audit
  // closes by requiring the scope key too.
  assert.equal(pickRegistry("@obversa/x", { registry: PUBLISH_REGISTRY_SENTINEL, [SCOPE_REGISTRY_KEY]: loopback }), loopback);
  // Both keys overridden, as the release's flags do: the flagged registry.
  assert.equal(pickRegistry("@obversa/x", { registry: loopback, [SCOPE_REGISTRY_KEY]: loopback }), loopback);
  // An unscoped name has no scope key to consult.
  assert.equal(pickRegistry("x", { registry: loopback, [SCOPE_REGISTRY_KEY]: PUBLISH_REGISTRY_SENTINEL }), loopback);
  // The publish command applies a manifest's publishConfig over the config
  // EXCEPT for keys given as CLI flags — the rule the release relies on when
  // it passes both registry keys as flags. Pinned by npm's own source.
  const publishCommand = readFileSync(path.join(NPM_DIR, "lib", "commands", "publish.js"), "utf8");
  assert.match(publishCommand, /Filter out properties set in CLI flags to prioritize them over[\s\S]{0,80}publishConfig/, "npm's publish command prefers CLI flags over publishConfig");
  assert.match(publishCommand, /Object\.entries\(manifest\.publishConfig\)\.filter\(\(\[key\]\) => !\(key in cliFlags\)\)/, "the filter is keyed by the flag names, so --registry and --@obversa:registry each displace their publishConfig key");
  // The release names exactly those two keys as flags.
  const args = publishArgs("/tmp/x.tgz", [], loopback);
  assert.ok(args.includes("--registry") && args.includes(`--${SCOPE_REGISTRY_KEY}=${loopback}`));
});

// A fake child for the release orchestrator: pending until told to exit,
// recording every signal it is sent.
function fakeRun(script) {
  const calls = [];
  const run = (command, args, { signals }) => {
    calls.push({ command, args });
    return new Promise((resolvePromise, reject) => script({ command, args, signals, resolve: resolvePromise, reject, calls }));
  };
  return { run, calls };
}

test("the release runs the guard again after pack, so a pack step that changed a tracked file never reaches npm", async () => {
  const { root, cwd, git } = makeReleaseRepo();
  const allowlist = new Set(["@x/p"]);
  const env = { OBVERSA_RELEASE: "1" };
  git("tag", "-a", "-m", "release @x/p 1.0.0", "x-p@1.0.0");
  const check = ({ cwd: dir }) => checkHook({ cwd: dir, env, allowlist });
  const plan = { name: "@x/p", cwd, pack: { command: "pnpm", args: ["pack", "--pack-destination"] }, publishArgs: (tarball) => publishArgs(tarball) };
  const logged = [];
  const dirs = [];
  const mkdtemp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "release-fake-")); dirs.push(dir); return dir; };
  try {
    // A pack that writes the tarball and also touches a tracked file.
    const mutating = fakeRun(({ command, args, resolve }) => {
      if (command === "pnpm") {
        writeFileSync(path.join(args.at(-1), "x-p-1.0.0.tgz"), "tar");
        writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "@x/p", version: "1.0.0", touched: true }));
      }
      resolve({ code: 0, signal: null });
    });
    assert.equal(await release(plan, { run: mutating.run, check, mkdtemp, log: (line) => logged.push(line) }), 1);
    assert.deepEqual(mutating.calls.map((c) => c.command), ["pnpm"], "npm was never started");
    assert.match(logged.join("\n"), /after pack, refusing to publish @x\/p: the working tree is not clean/);
    git("checkout", "--", "packages/p/package.json");
    // A clean pack: the guard passes again and npm runs with the tarball.
    const clean = fakeRun(({ command, args, resolve }) => {
      if (command === "pnpm") writeFileSync(path.join(args.at(-1), "x-p-1.0.0.tgz"), "tar");
      resolve({ code: 0, signal: null });
    });
    assert.equal(await release(plan, { run: clean.run, check, mkdtemp, log: (line) => logged.push(line) }), 0);
    assert.deepEqual(clean.calls.map((c) => c.command), ["pnpm", "npm"]);
    assert.match(clean.calls[1].args[1], /x-p-1\.0\.0\.tgz$/, "npm publishes the packed tarball");
    assert.ok(dirs.every((dir) => !existsSync(dir)), "the temporary pack directory is removed on every path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release forwards SIGINT and SIGTERM to the running child, awaits it, reports a stop or a spawn error, and removes the temporary directory", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "release-cancel-"));
  const plan = { name: "@x/p", cwd, pack: { command: "pnpm", args: ["pack", "--pack-destination"] }, publishArgs: (tarball) => publishArgs(tarball) };
  const dirs = [];
  const mkdtemp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "release-fake-")); dirs.push(dir); return dir; };
  const logged = [];
  try {
    // Cancellation: a real child that would run for a long time, a fake
    // signal source; SIGINT reaches the child and the release reports it.
    const signals = new EventEmitter();
    const pending = runChild(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd, signals, stdio: "ignore" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    signals.emit("SIGINT");
    const stopped = await pending;
    assert.equal(stopped.signal, "SIGINT", "the child was stopped by the forwarded signal");
    assert.equal(signals.listenerCount("SIGINT"), 0, "the forwarders are removed once the child has exited");
    // A visible spawn error.
    await assert.rejects(() => runChild(path.join(cwd, "no-such-command"), [], { cwd, signals, stdio: "ignore" }), /ENOENT/);
    // Through the release: a stopped pack and a failed spawn both return 1,
    // say why, and leave no temporary directory behind.
    const stoppedPack = fakeRun(({ resolve }) => resolve({ code: null, signal: "SIGTERM" }));
    assert.equal(await release(plan, { run: stoppedPack.run, check: () => [], mkdtemp, log: (line) => logged.push(line) }), 1);
    assert.match(logged.join("\n"), /pnpm pack was stopped by SIGTERM/);
    const failedSpawn = fakeRun(({ reject }) => reject(new Error("spawn pnpm ENOENT")));
    assert.equal(await release(plan, { run: failedSpawn.run, check: () => [], mkdtemp, log: (line) => logged.push(line) }), 1);
    assert.match(logged.join("\n"), /release: spawn pnpm ENOENT/);
    assert.ok(dirs.every((dir) => !existsSync(dir)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
