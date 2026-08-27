// Fail-closed npm publish guard.
//
// Why: a review subagent once ran `changeset publish --help`; changesets ignored
// the flag and published two public packages. A folder layout or `private: true`
// cannot stop that — shipped plugins must stay publishable for a standalone
// runtime consumer — so the guard is an explicit allowlist plus a release gate.
//
// Two modes:
//   1. Hook mode (default), run as a package's `prepublishOnly` script with the
//      package directory as cwd: refuse unless OBVERSA_RELEASE=1 is set AND the
//      package name is on scripts/publish-allowlist.json. npm and pnpm run
//      prepublishOnly before every publish, however publish was invoked.
//   2. `--audit`, run from the repository root: every workspace package that is
//      not private must be on the allowlist AND must carry the prepublishOnly
//      hook (without it a direct `npm publish` would skip the guard), and every
//      allowlisted name must be a real, non-private workspace package. This
//      keeps the list honest and the hook present.
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

export function checkHook({ cwd = process.cwd(), env = process.env, allowlist = readAllowlist() } = {}) {
  const manifestPath = join(cwd, "package.json");
  if (!existsSync(manifestPath)) return [`no package.json in ${cwd}`];
  const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  if (env.OBVERSA_RELEASE !== "1") problems.push(`refusing to publish ${name}: OBVERSA_RELEASE=1 is not set (this is the release gate)`);
  if (!allowlist.has(name)) problems.push(`refusing to publish ${name}: not on scripts/publish-allowlist.json`);
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
