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
//      tree, and HEAD carrying an ANNOTATED tag that names exactly this package
//      and version (see releaseTagFor). The tag binds the approval to one
//      package, so approving one 0.1.0 package never approves a sibling that
//      shares the number, and each package releases independently. npm and
//      pnpm run prepublishOnly before every publish, however publish was
//      invoked.
//   2. `--audit`, run from the repository root: every workspace package that is
//      not private must be on the allowlist AND must carry the exact
//      prepublishOnly hook (without it a direct `npm publish` would skip the
//      guard), and every allowlisted name must be a real, non-private workspace
//      package. This keeps the list honest and the hook present.
//
// Residual, on purpose: `pnpm publish --ignore-scripts` skips every lifecycle
// hook, so a token holder who deliberately passes that flag bypasses this
// guard. No hook can prevent that; it is a deliberate act, not the accidental
// publish this guard exists to stop.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "publish-allowlist.json");

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
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const p of packages) {
    if (p.private) continue;
    if (!allowlist.has(p.name)) {
      problems.push(`${p.name} (${p.dir}) is publishable but not on the allowlist: add it or set "private": true`);
    }
    if (p.prepublishOnly !== HOOK_COMMAND) {
      problems.push(`${p.name} (${p.dir}) is publishable but its scripts.prepublishOnly is not exactly "${HOOK_COMMAND}" (found "${p.prepublishOnly}")`);
    }
  }
  for (const name of allowlist) {
    const p = byName.get(name);
    if (!p) problems.push(`${name} is on the allowlist but is not a workspace package`);
    else if (p.private) problems.push(`${name} is on the allowlist but is marked private`);
  }
  return problems;
}

// The release record for one package version: an annotated git tag named for
// the package and the version. Encoding (filesystem- and refname-safe): drop
// the scope's "@", turn "/" into "-", then append "@<version>":
//   @obversa/lines 1.0.0  ->  obversa-lines@1.0.0
export function releaseTagFor(name, version) {
  return `${String(name).replace(/^@/, "").replace(/\//g, "-")}@${version}`;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
}

export function checkHook({ cwd = process.cwd(), env = process.env, allowlist = readAllowlist(), run = git } = {}) {
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return [`no package.json in ${cwd}`];
  const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  if (env.OBVERSA_RELEASE !== "1") problems.push(`refusing to publish ${name}: OBVERSA_RELEASE=1 is not set (the explicit release act)`);
  if (!allowlist.has(name)) problems.push(`refusing to publish ${name}: not on scripts/publish-allowlist.json`);

  // The release record: main, a clean tree, and this package's own annotated
  // tag at HEAD.
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
  const tag = releaseTagFor(name, version);
  if (!tags.includes(tag)) {
    problems.push(`refusing to publish ${name}: HEAD is not tagged ${tag} (the release record for this package and version)`);
  } else {
    let type = "";
    try { type = run(cwd, "cat-file", "-t", tag); } catch { type = ""; }
    if (type !== "tag") problems.push(`refusing to publish ${name}: ${tag} must be an annotated tag, not a lightweight one`);
  }
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
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
