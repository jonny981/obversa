// Fail-closed npm publish guard.
//
// Why: a review subagent once ran `changeset publish --help`; changesets ignored
// the flag and published two public packages. A folder layout or `private: true`
// cannot stop that — shipped plugins must stay publishable for a standalone
// runtime consumer — so the guard is an explicit allowlist plus a release gate.
//
// Two modes:
//   1. Hook mode (default), run as a package's `prepublishOnly` script with the
//      package directory as cwd: refuse unless OBVERSA_RELEASE=1 is set (the
//      explicit release act), the package name is on
//      scripts/publish-allowlist.json, the working tree is clean, and the
//      checkout is on `main` — or CI (GITHUB_ACTIONS=true), where the release
//      workflow's protected environment is the release act. npm and pnpm run
//      prepublishOnly when publishing a package DIRECTORY; publishing a
//      prepared tarball (`npm publish ./x.tgz`) runs no package hook at all,
//      so the hook is not the only seatbelt (see the residual below).
//   2. `--audit`, run from the repository root: every workspace package that is
//      not private must be on the allowlist, must carry the exact
//      prepublishOnly hook (without it a direct `npm publish` of the directory
//      would skip the guard), must set publishConfig.access to "public" (a
//      scoped package publishes restricted without it), may carry no registry
//      key at all (no `registry`, no `*:registry` — a manifest must not name a
//      registry route; the real registry is the npm default or the caller's
//      explicit flag) and no publishConfig.directory (pnpm would pack the
//      manifest inside that directory, which the audit never reads); every
//      allowlisted name must be a real, non-private workspace package; the
//      workspace root must stay private; and the release workflow must exist
//      and name both `changeset publish` and an `environment:` gate — a text
//      check that the sanctioned path is present, not proof of the GitHub
//      environment's protection rules, which only a human sees in the repo
//      settings.
//
// The release path: `.github/workflows/release.yml` runs `changeset publish`
// in a protected environment with `id-token: write`. Changesets invokes
// `pnpm publish` per package, which runs this hook and packs the tarball,
// then delegates the upload to the pinned npm client selected by pnpm's
// `npm-path` config. Package tags (`name@version`) come from changesets and
// scripts/tag-published.mjs; the old hand-managed repository `v<version>`
// tag, the never-resolving sentinel registry, and scripts/release.mjs are
// retired.
//
// Residual, on purpose, deliberate acts no script can prevent: a tarball
// publish (no hook runs) and a directory publish with `--ignore-scripts`, by
// a caller holding publish credentials. The controls for those are
// authentication — no standing npm token on development machines; trusted
// publishing scoped to the release workflow and its environment — and the
// environment approval itself. This guard exists to stop the accidental
// publish.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "publish-allowlist.json");

// The git the guard asks — for the branch and the clean tree — by absolute
// path from the system directories, never the first git on PATH: a fake git
// there could answer "main" and "clean" for a dirty checkout and let a
// real-registry publish through.
export const GIT_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"];
export function gitBin() {
  const found = GIT_DIRS.map((dir) => join(dir, "git")).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`publish guard: no git under ${GIT_DIRS.join(":")}`);
  return found;
}

export function readAllowlist(path = ALLOWLIST_PATH) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.packages) || parsed.packages.some((n) => typeof n !== "string")) {
    throw new Error(`${path}: "packages" must be an array of package names`);
  }
  return new Set(parsed.packages);
}

// Workspace packages from pnpm-workspace.yaml globs of the form `dir/*`.
export function listWorkspacePackages(root = ROOT) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  const found = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) continue;
    const base = join(root, glob.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      found.push({
        name: manifest.name,
        version: typeof manifest.version === "string" ? manifest.version : "",
        private: manifest.private === true,
        dir: join(glob.slice(0, -2), entry.name),
        prepublishOnly: typeof manifest.scripts?.prepublishOnly === "string" ? manifest.scripts.prepublishOnly : "",
        access: manifest.publishConfig?.access,
        publishConfig: manifest.publishConfig && typeof manifest.publishConfig === "object" ? manifest.publishConfig : {},
      });
    }
  }
  return found;
}

// The exact hook every publishable package must run: npm and pnpm execute
// prepublishOnly before any publish, so this is the check a direct publish
// cannot skip. Exact, not a substring: `echo check-publish-allowlist.mjs` or
// the script with `--audit` would otherwise count as the guard.
export const HOOK_COMMAND = "node ../../scripts/check-publish-allowlist.mjs";

// The registry every release targets — the value the verifier and the tag
// step pass explicitly so an ambient user config cannot redirect them.
export const RELEASE_REGISTRY = "https://registry.npmjs.org/";

// The sanctioned release path is the workflow that runs `changeset publish`
// behind a protected environment. The audit can only prove the file exists
// and names both — the environment's protection rules live in GitHub
// settings no script reads.
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const RELEASE_WORKFLOW_MARKERS = ["changeset publish", "environment:"];

export function audit({ root = ROOT, allowlist = readAllowlist() } = {}) {
  const problems = [];
  const packages = listWorkspacePackages(root);
  // Two directories claiming one name would let the later one stand in for
  // the earlier in every check keyed by name; this guard controls outward
  // publishing, so it fails closed on its own.
  const seen = new Map();
  for (const p of packages) {
    if (seen.has(p.name)) problems.push(`${p.name} is claimed by two workspace packages (${seen.get(p.name)} and ${p.dir}); a name belongs to one directory`);
    else seen.set(p.name, p.dir);
  }
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const p of packages) {
    if (p.private) continue;
    if (!allowlist.has(p.name)) {
      problems.push(`${p.name} (${p.dir}) is publishable but not on the allowlist: add it or set "private": true`);
    }
    if (p.prepublishOnly !== HOOK_COMMAND) {
      problems.push(`${p.name} (${p.dir}) is publishable but its scripts.prepublishOnly is not exactly "${HOOK_COMMAND}" (found "${p.prepublishOnly}")`);
    }
    if (p.access !== "public") {
      problems.push(`${p.name} (${p.dir}) is publishable but its publishConfig.access is not "public" (found ${JSON.stringify(p.access ?? null)}); a scoped package publishes restricted without it`);
    }
    for (const key of Object.keys(p.publishConfig)) {
      if (key === "registry" || /:registry$/.test(key)) {
        problems.push(`${p.name} (${p.dir}) names a registry route in publishConfig["${key}"]; a publishable manifest carries no registry key — the real registry is the npm default or the caller's explicit flag`);
      }
    }
    if (p.publishConfig.directory !== undefined) {
      problems.push(`${p.name} (${p.dir}) sets publishConfig.directory; pnpm would publish the manifest inside that directory, which this audit does not read`);
    }
  }
  for (const name of allowlist) {
    const p = byName.get(name);
    if (!p) problems.push(`${name} is on the allowlist but is not a workspace package`);
    else if (p.private) problems.push(`${name} is on the allowlist but is marked private`);
  }
  // The workspace root is not a package anyone publishes: it stays private,
  // or a version on it would make it one more publishable manifest the
  // package walk above never sees.
  const rootManifestPath = join(root, "package.json");
  if (!existsSync(rootManifestPath)) {
    problems.push("the workspace root has no package.json");
  } else if (JSON.parse(readFileSync(rootManifestPath, "utf8")).private !== true) {
    problems.push('the workspace root package.json must be "private": true');
  }
  const workflowPath = join(root, RELEASE_WORKFLOW);
  if (!existsSync(workflowPath)) {
    problems.push(`${RELEASE_WORKFLOW} is missing: it is the one guarded way to the real registry`);
  } else {
    const workflow = readFileSync(workflowPath, "utf8");
    for (const marker of RELEASE_WORKFLOW_MARKERS) {
      if (!workflow.includes(marker)) problems.push(`${RELEASE_WORKFLOW} does not name "${marker}": the guarded publish path requires it`);
    }
  }
  return problems;
}

function git(cwd, ...args) {
  return execFileSync(gitBin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
}

export function checkHook({ cwd = process.cwd(), env = process.env, allowlist = readAllowlist(), run = git } = {}) {
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return [`no package.json in ${cwd}`];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not valid JSON" : `could not be read: ${error.message}`;
    return [`refusing to publish: ${manifestPath} ${reason}`];
  }
  const name = manifest?.name;
  if (typeof name !== "string" || !name.trim()) return [`refusing to publish: ${manifestPath} must contain a non-empty package name`];
  const problems = [];
  if (env.OBVERSA_RELEASE !== "1") problems.push(`refusing to publish ${name}: OBVERSA_RELEASE=1 is not set (the explicit release act)`);
  if (!allowlist.has(name)) problems.push(`refusing to publish ${name}: not on scripts/publish-allowlist.json`);

  // The release record: a clean tree, on `main` for a local publish or in
  // Actions for the workflow publish (a CI checkout is a detached HEAD by
  // construction; the protected environment is the authorization there).
  let branch;
  let dirty;
  try {
    branch = run(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    dirty = run(cwd, "status", "--porcelain");
  } catch {
    problems.push(`refusing to publish ${name}: not inside a git repository`);
    return problems;
  }
  if (env.GITHUB_ACTIONS !== "true" && branch !== "main") problems.push(`refusing to publish ${name}: releases publish from main (checkout is on ${branch})`);
  if (dirty) problems.push(`refusing to publish ${name}: the working tree is not clean`);
  return problems;
}

// Compare real paths: Node resolves symlinks for import.meta but keeps the
// invoked path in argv, so a symlinked invocation must still count as main.
const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const problems = process.argv.includes("--audit") ? audit() : checkHook();
  if (problems.length) {
    for (const p of problems) console.error(`publish guard: ${p}`);
    process.exit(1);
  }
  console.log(process.argv.includes("--audit")
    ? `Publish allowlist audit passed for ${listWorkspacePackages().filter((p) => !p.private).length} publishable packages.`
    : "publish guard: allowed");
}
