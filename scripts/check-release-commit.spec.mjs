import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gitBin } from "./check-publish-allowlist.mjs";
import { checkReleaseCommit } from "./check-release-commit.mjs";

function git(cwd, ...args) {
  return execFileSync(gitBin(), ["-c", "user.name=Release Test", "-c", "user.email=release@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, file, content) {
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

const A = { name: "@x/a", version: "1.0.0", scripts: { build: "tsc" }, dependencies: { "@x/b": "1.0.0", "left-pad": "1.0.0" } };
const B = { name: "@x/b", version: "1.0.0" };

// A repository whose HEAD is a parent commit, ready for a release commit on top.
function makeRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-commit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  write(root, "packages/a/package.json", A);
  write(root, "packages/a/CHANGELOG.md", "# @x/a\n");
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  write(root, "plugins/b/package.json", B);
  write(root, "docs/public/packages/index.mdx", "| @x/a | 1.0.0 |\n");
  write(root, ".changeset/config.json", "{}\n");
  write(root, ".changeset/README.md", "# Changesets\n");
  write(root, ".changeset/bump.md", "---\n\"@x/a\": patch\n---\n\nA fix.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "parent");
  return { root, parent: git(root, "rev-parse", "HEAD") };
}

// What `pnpm changeset version` and the docs package table write.
function versionPackages(root, { a = {} } = {}) {
  write(root, "packages/a/package.json", { ...A, version: "1.0.1", dependencies: { ...A.dependencies, "@x/b": "1.0.1" }, ...a });
  write(root, "packages/a/CHANGELOG.md", "# @x/a\n\n## 1.0.1\n\n- A fix.\n");
  write(root, "plugins/b/package.json", { ...B, version: "1.0.1" });
  write(root, "plugins/b/CHANGELOG.md", "# @x/b\n\n## 1.0.1\n");
  write(root, "docs/public/packages/index.mdx", "| @x/a | 1.0.1 |\n");
  unlinkSync(path.join(root, ".changeset/bump.md"));
}

function commit(root) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "release");
}

const ENV = { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "token" };

function ciPassedOn(sha, calls = []) {
  return async (request) => {
    calls.push(request);
    return { workflow_runs: [{ name: "CI", head_sha: sha, status: "completed", conclusion: "success" }] };
  };
}

test("a release commit that only versions packages passes when its parent passed CI", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root);
  commit(root);
  const calls = [];
  assert.deepEqual(await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent, calls) }), []);
  assert.deepEqual(calls, [{ repository: "owner/repo", sha: parent, token: "token" }]);
});

test("a release commit that changes a source file fails and names it", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root);
  write(root, "packages/a/src/index.ts", "export const a = 2;\n");
  commit(root);
  const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^packages\/a\/src\/index\.ts: /);
});

test("a manifest change outside version and workspace dependency versions fails and names the field", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root, { a: { scripts: { build: "tsc -b" } } });
  commit(root);
  const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^packages\/a\/package\.json: the field "scripts\.build" changed/);
});

test("a version change of a dependency that is not a workspace package fails and names it", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root, { a: { dependencies: { "@x/b": "1.0.1", "left-pad": "1.0.1" } } });
  commit(root);
  const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^packages\/a\/package\.json: the field "dependencies\.left-pad" changed/);
});

test("a release commit that adds a changeset fails", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root);
  write(root, ".changeset/another.md", "---\n\"@x/b\": patch\n---\n\nMore.\n");
  commit(root);
  const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^\.changeset\/another\.md: .*added/);
});

test("a merge commit fails", async (t) => {
  const { root, parent } = makeRepo(t);
  git(root, "checkout", "-q", "-b", "side");
  write(root, "plugins/b/README.md", "# @x/b\n");
  commit(root);
  git(root, "checkout", "-q", "-");
  versionPackages(root);
  commit(root);
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
  const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has 2 parents/);
});

test("a release commit whose parent has no successful CI run fails", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root);
  commit(root);
  for (const runs of [
    [],
    [{ name: "CI", head_sha: parent, status: "completed", conclusion: "failure" }],
    [{ name: "Release", head_sha: parent, status: "completed", conclusion: "success" }],
  ]) {
    const problems = await checkReleaseCommit({ cwd: root, env: ENV, readCiRuns: async () => ({ workflow_runs: runs }) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`^parent ${parent}: no successful run of the CI workflow`));
  }
});

test("the check needs a GitHub token to read the parent's CI runs", async (t) => {
  const { root, parent } = makeRepo(t);
  versionPackages(root);
  commit(root);
  const problems = await checkReleaseCommit({ cwd: root, env: { GITHUB_REPOSITORY: "owner/repo" }, readCiRuns: ciPassedOn(parent) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GITHUB_TOKEN or GH_TOKEN/);
});

test("the repository comes from the origin remote when GITHUB_REPOSITORY is not set", async (t) => {
  const { root, parent } = makeRepo(t);
  git(root, "remote", "add", "origin", "git@github.com:someone/project.git");
  versionPackages(root);
  commit(root);
  const calls = [];
  assert.deepEqual(await checkReleaseCommit({ cwd: root, env: { GH_TOKEN: "token" }, readCiRuns: ciPassedOn(parent, calls) }), []);
  assert.equal(calls[0].repository, "someone/project");
});
