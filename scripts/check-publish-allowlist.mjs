// Fail-closed npm publish guard.
//
// Why: a review subagent once ran `changeset publish --help`; changesets ignored
// the flag and published two public packages. A folder layout or `private: true`
// cannot stop that — shipped plugins must stay publishable for a standalone
// runtime consumer — so the guard is an explicit allowlist plus a release gate.
//
// Two modes:
//   1. Hook mode (default), run as a package's `prepublishOnly` script with the
//      package directory as cwd: refuse unless every part of the release record
//      is present — OBVERSA_RELEASE=1 (the explicit human act), the package name
//      on scripts/publish-allowlist.json, the checkout on `main` with a clean
//      tree, and HEAD carrying one annotated repository release tag. npm and
//      pnpm run prepublishOnly when publishing a package DIRECTORY; publishing
//      a prepared tarball (`npm publish ./x.tgz`) runs no package hook at all,
//      so the hook is not the only seatbelt (see the registry below).
//   2. `--audit`, run from the repository root: every workspace package that is
//      not private must be on the allowlist, must carry the exact
//      prepublishOnly hook (without it a direct `npm publish` of the directory
//      would skip the guard), must name PUBLISH_REGISTRY_SENTINEL as both its
//      publishConfig.registry and its publishConfig["@obversa:registry"] (see
//      below), may carry no other registry key and no publishConfig.directory;
//      every allowlisted name must be a real, non-private workspace package;
//      the workspace root must stay private; and the release command must
//      exist.
//
// The registry seatbelt: every public manifest — and so every tarball packed
// from it — names a registry that never resolves (PUBLISH_REGISTRY_SENTINEL,
// a name under the reserved .invalid domain). npm, pnpm, and changesets pick
// the registry for a scoped name from the scope key first
// (`@obversa:registry`) and only then from `registry`, and a manifest's
// publishConfig beats a user's config for both keys, so a plain sentinel
// alone would be stepped over by a scoped real registry in the manifest or in
// a standing user config; the audit therefore requires the sentinel under
// BOTH keys and refuses any other registry key. publishConfig.directory is
// refused too: pnpm packs the manifest inside that directory, which the
// audit never reads. A publish that skips the hook, from a directory or from
// a tarball, is sent to the sentinel and fails. The supported way to the real
// registry is scripts/release.mjs: it runs checkHook first, packs the one
// listed public workspace package with pnpm (which rewrites workspace
// versions), and publishes that tarball with npm, overriding both registry
// keys on the command line — the one place npm lets a flag beat
// publishConfig.
//
// Residual, on purpose, two deliberate acts no script can prevent: a
// directory publish with `--ignore-scripts` and both registry keys
// overridden, and a tarball publish with both keys overridden (a tarball
// runs no hook). This guard exists to stop the accidental publish.
export const PUBLISH_REGISTRY_SENTINEL = "http://publish-guard.invalid/";
export const SCOPE_REGISTRY_KEY = "@obversa:registry";
export const RELEASE_REGISTRY = "https://registry.npmjs.org/";
export const RELEASE_COMMAND = "scripts/release.mjs";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "publish-allowlist.json");

// The git the guard asks — for the branch, the clean tree, the release tag
// and its type — by absolute path from the system directories, never the
// first git on PATH: a fake git there could answer "main", "clean", and
// "tag" for a dirty, untagged checkout and let a real-registry publish
// through with both registry keys overridden.
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
        private: manifest.private === true,
        dir: join(glob.slice(0, -2), entry.name),
        prepublishOnly: typeof manifest.scripts?.prepublishOnly === "string" ? manifest.scripts.prepublishOnly : "",
        registry: typeof manifest.publishConfig?.registry === "string" ? manifest.publishConfig.registry : "",
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
    if (p.registry !== PUBLISH_REGISTRY_SENTINEL) {
      problems.push(`${p.name} (${p.dir}) is publishable but its publishConfig.registry is not ${PUBLISH_REGISTRY_SENTINEL} (found "${p.registry}"); a tarball publish would reach a real registry without the guard`);
    }
    if (p.publishConfig[SCOPE_REGISTRY_KEY] !== PUBLISH_REGISTRY_SENTINEL) {
      problems.push(`${p.name} (${p.dir}) is publishable but its publishConfig["${SCOPE_REGISTRY_KEY}"] is not ${PUBLISH_REGISTRY_SENTINEL} (found "${p.publishConfig[SCOPE_REGISTRY_KEY] ?? ""}"); the scope key is picked before registry, so a scoped real registry in a manifest or a user config would step over the plain sentinel`);
    }
    for (const key of Object.keys(p.publishConfig)) {
      if (/:registry$/.test(key) && key !== SCOPE_REGISTRY_KEY) {
        problems.push(`${p.name} (${p.dir}) names another registry route in publishConfig["${key}"]; only registry and ${SCOPE_REGISTRY_KEY} are allowed, both set to the sentinel`);
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
  if (!existsSync(join(root, RELEASE_COMMAND))) problems.push(`${RELEASE_COMMAND} is missing: it is the one guarded way to the real registry`);
  return problems;
}

// The repository release record is one annotated tag shared by every package.
export function releaseTagFor(version) {
  return `v${version}`;
}

function git(cwd, ...args) {
  return execFileSync(gitBin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
}

export function checkHook({ cwd = process.cwd(), env = process.env, allowlist = readAllowlist(), run = git } = {}) {
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return [`no package.json in ${cwd}`];
  const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  if (env.OBVERSA_RELEASE !== "1") problems.push(`refusing to publish ${name}: OBVERSA_RELEASE=1 is not set (the explicit release act)`);
  if (!allowlist.has(name)) problems.push(`refusing to publish ${name}: not on scripts/publish-allowlist.json`);

  // The release record: main, a clean tree, and the runtime version's annotated
  // repository tag at HEAD, shared by every package.
  let branch;
  let dirty;
  let tags;
  try {
    branch = run(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    dirty = run(cwd, "status", "--porcelain");
    tags = run(cwd, "tag", "--points-at", "HEAD").split("\n").filter(Boolean);
  } catch {
    problems.push(`refusing to publish ${name}: not inside a git repository`);
    return problems;
  }
  if (branch !== "main") problems.push(`refusing to publish ${name}: releases publish from main (checkout is on ${branch})`);
  if (dirty) problems.push(`refusing to publish ${name}: the working tree is not clean`);
  const releaseTags = tags.filter((tag) => /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag));
  if (releaseTags.length !== 1) {
    problems.push(`refusing to publish ${name}: HEAD must carry exactly one annotated repository release tag (found ${releaseTags.join(", ") || "none"})`);
  } else {
    const tag = releaseTags[0];
    const root = run(cwd, "rev-parse", "--show-toplevel");
    const { version } = JSON.parse(readFileSync(join(root, "packages", "runtime", "package.json"), "utf8"));
    const expectedTag = releaseTagFor(version);
    if (tag !== expectedTag) problems.push(`refusing to publish ${name}: repository release tag must be ${expectedTag} (found ${tag})`);
    let type = "";
    try { type = run(cwd, "cat-file", "-t", tag); } catch { type = ""; }
    if (type !== "tag") problems.push(`refusing to publish ${name}: ${tag} must be an annotated tag, not a lightweight one`);
  }
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
