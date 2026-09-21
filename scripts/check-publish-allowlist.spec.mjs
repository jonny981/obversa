import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GIT_DIRS, HOOK_COMMAND, RELEASE_REGISTRY, RELEASE_WORKFLOW, RELEASE_WORKFLOW_MARKERS, audit, checkHook, gitBin, listWorkspacePackages } from "./check-publish-allowlist.mjs";
import { verifyPublished } from "./verify-published.mjs";
import { tagPublished } from "./tag-published.mjs";

function makeWorkspace(packages, { rootManifest = { name: "workspace", private: true }, workflow = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "publish-guard-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - plugins/*\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify(rootManifest));
  if (workflow !== null) {
    mkdirSync(path.join(root, path.dirname(RELEASE_WORKFLOW)), { recursive: true });
    writeFileSync(path.join(root, RELEASE_WORKFLOW), workflow);
  }
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

// The fixture publishable manifest: allowlisted, hooked, scoped-public, and
// carrying no registry route — the shape the combined release tree requires.
const PUBLISHABLE = { scripts: { prepublishOnly: HOOK_COMMAND }, publishConfig: { access: "public" } };
const WORKFLOW = `jobs:\n  publish:\n    environment: release\n    steps:\n      - run: pnpm changeset publish\n`;

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

test("the audit fails closed: an unlisted public package, a missing or wrong hook, a listed private one, and a listed ghost", () => {
  const root = makeWorkspace({
    "packages/pub": { name: "@x/pub", ...PUBLISHABLE },
    "packages/nohook": { name: "@x/nohook", scripts: { build: "tsup" }, publishConfig: { access: "public" } },
    // Lookalikes that mention the script but do not run the guard.
    "packages/echo": { name: "@x/echo", scripts: { prepublishOnly: "echo check-publish-allowlist.mjs" }, publishConfig: { access: "public" } },
    "packages/audit": { name: "@x/audit", scripts: { prepublishOnly: "node ../../scripts/check-publish-allowlist.mjs --audit" }, publishConfig: { access: "public" } },
    "packages/priv": { name: "@x/priv", private: true },
    "packages/ok": { name: "@x/ok", ...PUBLISHABLE },
  }, { workflow: WORKFLOW });
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

test("the audit refuses every registry route in a publishable manifest — registry, any scope key, a directory — and requires public access", () => {
  const good = { name: "@obversa/pub", version: "1.0.0", ...PUBLISHABLE };
  const root = makeWorkspace({
    "packages/pub": good,
    "packages/real": { ...good, name: "@obversa/real", publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } },
    // A scoped route beside the default: npm picks the scope key first, so
    // even a retired-sentinel value must not survive the removal.
    "packages/scoped": { ...good, name: "@obversa/scoped", publishConfig: { access: "public", "@obversa:registry": "http://publish-guard.invalid/" } },
    "packages/other": { ...good, name: "@obversa/other", publishConfig: { access: "public", "@elsewhere:registry": "https://registry.npmjs.org/" } },
    "packages/nested": { ...good, name: "@obversa/nested", publishConfig: { access: "public", directory: "dist" } },
    "packages/noaccess": { ...good, name: "@obversa/noaccess", publishConfig: {} },
    "packages/priv": { name: "@obversa/priv", private: true, publishConfig: { registry: "https://example.invalid/" } },
  }, { workflow: WORKFLOW });
  try {
    const problems = audit({ root, allowlist: new Set(["@obversa/pub", "@obversa/real", "@obversa/scoped", "@obversa/other", "@obversa/nested", "@obversa/noaccess"]) });
    assert.ok(problems.some((p) => p.startsWith("@obversa/real ") && p.includes('publishConfig["registry"]')), "a manifest registry route is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/scoped ") && p.includes('publishConfig["@obversa:registry"]')), "a leftover sentinel scope key is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/other ") && p.includes('publishConfig["@elsewhere:registry"]')), "any other registry route is refused");
    assert.ok(problems.some((p) => p.startsWith("@obversa/nested ") && p.includes("publishConfig.directory")), "a publish directory hides a manifest the audit does not read");
    assert.ok(problems.some((p) => p.startsWith("@obversa/noaccess ") && p.includes('publishConfig.access is not "public"')), "a scoped package without public access publishes restricted");
    assert.ok(!problems.some((p) => p.startsWith("@obversa/pub ")), "the publishable shape passes");
    assert.ok(!problems.some((p) => p.startsWith("@obversa/priv ")), "a private package is not held to it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the audit requires the release workflow to exist and to name the publish command and the environment gate", () => {
  const pkg = { name: "@obversa/pub", version: "1.0.0", ...PUBLISHABLE };
  const missing = makeWorkspace({ "packages/pub": pkg });
  const wrong = makeWorkspace({ "packages/pub": pkg }, { workflow: "jobs:\n  verify:\n    steps:\n      - run: pnpm test\n" });
  const ungated = makeWorkspace({ "packages/pub": pkg }, { workflow: "jobs:\n  publish:\n    steps:\n      - run: pnpm changeset publish\n" });
  const right = makeWorkspace({ "packages/pub": pkg }, { workflow: WORKFLOW });
  try {
    assert.ok(audit({ root: missing, allowlist: new Set(["@obversa/pub"]) }).some((p) => p.includes(`${RELEASE_WORKFLOW} is missing`)));
    const wrongProblems = audit({ root: wrong, allowlist: new Set(["@obversa/pub"]) }).join("\n");
    for (const marker of RELEASE_WORKFLOW_MARKERS) assert.match(wrongProblems, new RegExp(`does not name "${marker.replace(":", "\\:")}"`));
    assert.match(audit({ root: ungated, allowlist: new Set(["@obversa/pub"]) }).join("\n"), /does not name "environment:"/, "a publish step without an environment gate is refused");
    assert.deepEqual(audit({ root: right, allowlist: new Set(["@obversa/pub"]) }), []);
  } finally {
    for (const root of [missing, wrong, ungated, right]) rmSync(root, { recursive: true, force: true });
  }
});

test("the audit pins the workspace root private, so a version on it cannot make one more publishable manifest", () => {
  const pkg = { name: "@obversa/pub", version: "1.0.0", ...PUBLISHABLE };
  const publicRoot = makeWorkspace({ "packages/pub": pkg }, { rootManifest: { name: "obversa", version: "1.0.0" }, workflow: WORKFLOW });
  const privateRoot = makeWorkspace({ "packages/pub": pkg }, { workflow: WORKFLOW });
  try {
    assert.ok(audit({ root: publicRoot, allowlist: new Set(["@obversa/pub"]) }).some((p) => /workspace root package\.json must be "private": true/.test(p)));
    assert.ok(!audit({ root: privateRoot, allowlist: new Set(["@obversa/pub"]) }).some((p) => /workspace root/.test(p)));
  } finally {
    rmSync(publicRoot, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("the publish audit fails closed on a package name claimed by two workspace directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publish-dup-"));
  try {
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const dir of ["one", "two"]) {
      mkdirSync(path.join(root, "packages", dir), { recursive: true });
      writeFileSync(path.join(root, "packages", dir, "package.json"), JSON.stringify({ name: "@obversa/twice", version: "0.0.0", private: true }));
    }
    const problems = audit({ root, allowlist: new Set() });
    assert.ok(problems.some((p) => /@obversa\/twice is claimed by two workspace packages \(packages\/one and packages\/two\)/.test(p)), problems.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A git repository around one workspace package, so the hook's release-record
// checks (branch, clean tree) run against the real thing.
function makeReleaseRepo() {
  const root = makeWorkspace({
    "packages/p": { name: "@x/p", version: "0.1.0" },
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
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

test("the hook requires the release record: a clean tree on main, or CI", () => {
  const { root, cwd, git } = makeReleaseRepo();
  try {
    const allowlist = new Set(["@x/p"]);
    const env = { OBVERSA_RELEASE: "1" };
    assert.deepEqual(checkHook({ cwd, env, allowlist }), [], "a clean main checkout with the flag passes");
    writeFileSync(path.join(cwd, "scratch.txt"), "wip\n");
    assert.match(checkHook({ cwd, env, allowlist }).join("\n"), /working tree is not clean/);
    rmSync(path.join(cwd, "scratch.txt"));
    git("checkout", "-q", "-b", "feature");
    assert.match(checkHook({ cwd, env, allowlist }).join("\n"), /releases publish from main/);
    // In Actions the checkout is detached by construction; the protected
    // environment is the authorization, so the branch rule does not apply.
    assert.deepEqual(checkHook({ cwd, env: { ...env, GITHUB_ACTIONS: "true" }, allowlist }), []);
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

for (const [label, contents, reason] of [
  ["malformed JSON", "{", "is not valid JSON"],
  ["null contents", "null", "must contain a non-empty package name"],
]) {
  test(`the hook refuses its own manifest with ${label}`, () => {
    const { root, git } = makeReleaseRepo();
    const cwd = path.join(root, "packages", "p");
    try {
      writeFileSync(path.join(cwd, "package.json"), contents);
      git("add", ".");
      git("commit", "-q", "-m", "invalid manifest");
      assert.deepEqual(checkHook({ cwd, env: { OBVERSA_RELEASE: "1" }, allowlist: new Set(["@x/p"]) }), [
        `refusing to publish: ${path.join(cwd, "package.json")} ${reason}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the publish guard asks a git from the system directories, whatever git is first on PATH", () => {
  const bin = gitBin();
  assert.ok(GIT_DIRS.some((dir) => bin === path.join(dir, "git")), bin);
  // A fake git first on PATH that answers "main" and "clean" for everything
  // changes nothing: the guard never consults PATH.
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), "fake-git-"));
  writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\ncase \"$*\" in *rev-parse*) echo main;; *) echo;; esac\n");
  chmodSync(path.join(fakeBin, "git"), 0o755);
  const repoRoot = new URL("..", import.meta.url).pathname;
  const target = path.join(repoRoot, "packages", "api");
  const direct = JSON.stringify(checkHook({ cwd: target }));
  const child = spawnSync(process.execPath, ["-e", "import('./scripts/check-publish-allowlist.mjs').then((m) => console.log(JSON.stringify(m.checkHook({ cwd: process.argv[1] }))))", target], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), direct, "the same answer with the fake git first on PATH");
  assert.ok(direct.includes("main") || direct.includes("clean") || direct === "[]", "the real git answered about this checkout");
});

// The npm the release workflow publishes with is the root-pinned devDependency,
// selected through pnpm's npm-path — never whichever npm is first on PATH.
// npm's trusted publishing requires the client floor below.
const ROOT_MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the publish client is an exact npm pin at or above the trusted-publishing floor", () => {
  const pinned = ROOT_MANIFEST.devDependencies.npm;
  assert.match(pinned, /^\d+\.\d+\.\d+$/, "npm is pinned exactly");
  const [major, minor, patch] = pinned.split(".").map(Number);
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))), `npm ${pinned} is below the trusted-publishing floor 11.5.1`);
});

// A stand-in npm that answers `view <name>@<version> --registry <r> version`
// per package: a hit, a missing version (exit 0, empty answer — npm's real
// shape), a wrong version, a registry error, and one that fails to spawn.
function makeStubNpm() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stub-npm-"));
  const npm = path.join(dir, "npm");
  writeFileSync(npm, `#!/bin/sh
# args: view <name@version> --registry <registry> version
[ "$4" = "${RELEASE_REGISTRY}" ] || { echo "queried a registry that is not the release registry: $4" >&2; exit 2; }
case "$2" in
  "@x/hit@1.0.0"|"@x/published@1.0.0"|"@x/tagged@1.0.0"|"@x/flaky@1.0.0") echo "1.0.0" ;;
  "@x/wrong@1.0.0") echo "9.9.9" ;;
  "@x/down@1.0.0") echo "E404 Not Found" >&2; exit 1 ;;
  *) exit 0 ;; # exit 0 with no answer: npm's shape for a missing version
esac
`);
  chmodSync(npm, 0o755);
  return { dir, npm };
}

test("the publish verifier accepts hits and names missing, wrong, and failed registry answers", () => {
  const { dir, npm } = makeStubNpm();
  const root = makeWorkspace({
    "packages/hit": { name: "@x/hit", version: "1.0.0" },
    "packages/missing": { name: "@x/missing", version: "1.0.0" },
    "packages/wrong": { name: "@x/wrong", version: "1.0.0" },
    "packages/down": { name: "@x/down", version: "1.0.0" },
  });
  const allowlist = new Set(["@x/hit", "@x/missing", "@x/wrong", "@x/down", "@x/ghost"]);
  try {
    const problems = verifyPublished({ npm, root, allowlist }).join("\n");
    assert.doesNotMatch(problems, /@x\/hit/);
    assert.match(problems, /@x\/missing@1\.0\.0: not on the registry/);
    assert.match(problems, /@x\/wrong@1\.0\.0: not on the registry \(registry answered "9\.9\.9"\)/);
    assert.match(problems, /@x\/down@1\.0\.0: the registry query failed \(E404 Not Found\)/);
    assert.match(problems, /@x\/ghost: on the allowlist but not a workspace package/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the publish verifier reports an npm that cannot run at all", () => {
  const root = makeWorkspace({ "packages/hit": { name: "@x/hit", version: "1.0.0" } });
  try {
    const problems = verifyPublished({ npm: path.join(root, "no-such-npm"), root, allowlist: new Set(["@x/hit"]) }).join("\n");
    assert.match(problems, /@x\/hit@1\.0\.0: the registry query could not run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tag step pushes each existing registry-confirmed tag by name and refuses the rest", () => {
  const { dir, npm } = makeStubNpm();
  const root = makeWorkspace({
    "packages/published": { name: "@x/published", version: "1.0.0" },
    "packages/tagged": { name: "@x/tagged", version: "1.0.0" },
    "packages/missing": { name: "@x/missing", version: "1.0.0" },
    "packages/flaky": { name: "@x/flaky", version: "1.0.0" },
  });
  const allowlist = new Set(["@x/published", "@x/tagged", "@x/missing", "@x/flaky"]);
  // A fake spawn: git answers by argv — @x/tagged and @x/flaky have their
  // tag, @x/published's is missing (the retry gap), @x/flaky's push is
  // rejected.
  const calls = [];
  const run = (command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse") return { status: args.some((a) => a === "refs/tags/@x/tagged@1.0.0" || a === "refs/tags/@x/flaky@1.0.0") ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "push") return { status: args.some((a) => a.includes("@x/flaky")) ? 1 : 0, stdout: "", stderr: "rejected" };
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const { pushed, problems } = tagPublished({ npm, root, allowlist, run });
    const text = problems.join("\n");
    assert.deepEqual(pushed, ["@x/tagged@1.0.0"], "only the existing tag is pushed");
    assert.ok(calls.some((c) => c === "push origin refs/tags/@x/tagged@1.0.0"), "the intended tag is pushed by name");
    assert.ok(!calls.some((c) => c.includes("--tags")), "never a blanket --tags push");
    // Regression: registry-present plus a missing local tag must never run
    // git tag or git push for it — the registry cannot prove HEAD published
    // that version, so inventing the tag would falsify the release record.
    assert.match(text, /@x\/published@1\.0\.0: published but the tag does not exist locally.*Tag the commit that published/);
    assert.ok(!calls.some((c) => c.includes("@x/published") && (c.startsWith("tag ") || c.startsWith("push "))), "no tag/push for the missing tag");
    assert.match(text, /@x\/missing@1\.0\.0: not on the registry .* nothing to push/);
    assert.match(text, /@x\/flaky@1\.0\.0: push failed \(rejected\)/);
    assert.ok(!calls.some((c) => c.startsWith("tag ")), "no tag is ever created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
