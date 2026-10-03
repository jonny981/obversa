// Release-commit check. The Release workflow publishes a commit that
// `pnpm changeset version` wrote on top of a commit that already passed CI,
// so it runs this check instead of the full proof chain. A commit passes only
// when it has one parent, that parent has a successful CI run on GitHub, and
// it changes nothing but release files:
//
// - `packages/*/package.json` and `plugins/*/package.json`: `version` and the
//   versions of dependencies that name a workspace package;
// - `packages/*/CHANGELOG.md` and `plugins/*/CHANGELOG.md`;
// - `docs/public/packages/index.mdx`, the package table;
// - `.changeset/*.md`, deleted only.
//
// Git comes from the system directories, the same hardening as the publish
// guard. Usage: node scripts/check-release-commit.mjs [commit]
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBin } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MANIFEST = /^(packages|plugins)\/[^/]+\/package\.json$/;
const CHANGELOG = /^(packages|plugins)\/[^/]+\/CHANGELOG\.md$/;
const PACKAGE_TABLE = "docs/public/packages/index.mdx";
const CHANGESET = /^\.changeset\/[^/]+\.md$/;
const DEPENDENCY_FIELDS = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
const STATUS = { A: "added", C: "copied", D: "deleted", M: "changed", R: "renamed", T: "changed type" };

function git(cwd, ...args) {
  return execFileSync(gitBin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

// Every path below a and b whose value differs, as arrays of keys.
function changedFields(a, b, at = []) {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(a) || !isObject(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => changedFields(a[key], b[key], [...at, key]));
}

function workspaceNames(cwd, commit) {
  const paths = git(cwd, "ls-tree", "-r", "--name-only", commit, "--", "packages", "plugins").split("\n").filter((p) => MANIFEST.test(p));
  return new Set(paths.map((p) => JSON.parse(git(cwd, "show", `${commit}:${p}`)).name));
}

function repositoryOf(cwd, env) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const url = git(cwd, "remote", "get-url", "origin").trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`the origin remote ${url} is not a GitHub repository`);
  return `${match[1]}/${match[2]}`;
}

export async function readCiRunsFromGitHub({ repository, sha, token }) {
  const url = `https://api.github.com/repos/${repository}/actions/runs?head_sha=${sha}&status=success&per_page=100`;
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  return response.json();
}

export async function checkReleaseCommit({ commit = "HEAD", cwd = ROOT, env = process.env, readCiRuns = readCiRunsFromGitHub } = {}) {
  const sha = git(cwd, "rev-parse", "--verify", `${commit}^{commit}`).trim();
  const parents = git(cwd, "rev-list", "--parents", "-n", "1", sha).trim().split(" ").slice(1);
  if (parents.length !== 1) return [`${sha} has ${parents.length} parents; a release commit has exactly one.`];
  const [parent] = parents;

  const problems = [];
  const fields = git(cwd, "diff-tree", "-r", "-z", "--no-renames", "--name-status", parent, sha).split("\0").filter(Boolean);
  let names;
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i][0];
    const path = fields[i + 1];
    const what = STATUS[status] ?? `status ${status}`;
    if (MANIFEST.test(path)) {
      if (status !== "M") {
        problems.push(`${path}: a release commit only changes a package manifest, and this one is ${what}.`);
        continue;
      }
      let before, after;
      try {
        before = JSON.parse(git(cwd, "show", `${parent}:${path}`));
        after = JSON.parse(git(cwd, "show", `${sha}:${path}`));
      } catch {
        problems.push(`${path}: the manifest is not valid JSON.`);
        continue;
      }
      names ??= workspaceNames(cwd, sha);
      for (const field of changedFields(before, after)) {
        const allowed = (field.length === 1 && field[0] === "version")
          || (field.length === 2 && DEPENDENCY_FIELDS.has(field[0]) && names.has(field[1]) && typeof before[field[0]]?.[field[1]] === "string" && typeof after[field[0]]?.[field[1]] === "string");
        if (!allowed) problems.push(`${path}: the field "${field.join(".")}" changed, and a release commit changes only "version" and the versions of workspace dependencies.`);
      }
    } else if (CHANGELOG.test(path)) {
      if (status !== "A" && status !== "M") problems.push(`${path}: a release commit only adds or changes a changelog, and this one is ${what}.`);
    } else if (path === PACKAGE_TABLE) {
      if (status !== "M") problems.push(`${path}: a release commit only changes the package table, and this one is ${what}.`);
    } else if (CHANGESET.test(path) && path !== ".changeset/README.md") {
      if (status !== "D") problems.push(`${path}: a release commit only deletes changesets, and this one is ${what}.`);
    } else {
      problems.push(`${path}: a release commit changes only package versions, changelogs, the package table and deleted changesets, and this file is ${what}.`);
    }
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    problems.push(`parent ${parent}: there is no GitHub token to read its CI runs; set GITHUB_TOKEN or GH_TOKEN.`);
    return problems;
  }
  try {
    const { workflow_runs: runs = [] } = await readCiRuns({ repository: repositoryOf(cwd, env), sha: parent, token });
    if (!runs.some((run) => run.name === "CI" && run.head_sha === parent && run.status === "completed" && run.conclusion === "success")) {
      problems.push(`parent ${parent}: no successful run of the CI workflow on GitHub; land the change through CI first.`);
    }
  } catch (error) {
    problems.push(`parent ${parent}: the CI runs could not be read (${error.message}).`);
  }
  return problems;
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const commit = process.argv[2] ?? "HEAD";
  const problems = await checkReleaseCommit({ commit, cwd: process.cwd() });
  if (problems.length) {
    for (const p of problems) console.error(`release commit: ${p}`);
    process.exit(1);
  }
  console.log(`release commit: ${commit} changes only release files and its parent passed CI`);
}
