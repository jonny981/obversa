// publint and @arethetypeswrong/cli on every packed public tarball
// (an internal note).
//
// Each package the publish allowlist names is packed with the pinned pnpm,
// then both tools read the tarball itself — the artifact a registry would
// serve — so what they prove is the shape a consumer installs, not the
// working tree. publint proves the manifest's paths exist and make sense;
// attw proves the package's own types resolve under every TypeScript
// resolution mode. Neither proves how a real consumer's runtime resolves it;
// the clean-consumer proof does that.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { listWorkspacePackages } from "./check-publish-allowlist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const require = createRequire(import.meta.url);

// The pinned tools, by real path, run under this Node: never whichever copy
// is first on PATH.
const PNPM_CLI = join(dirname(require.resolve("pnpm")), "bin", "pnpm.cjs");
// publint's exports map exposes only its library entry, so its bin is the
// entry's sibling; attw exposes its package.json, so its bin resolves from
// the package directory.
const PUBLINT_CLI = join(dirname(require.resolve("publint")), "cli.js");
const ATTW_CLI = join(dirname(require.resolve("@arethetypeswrong/cli/package.json")), "dist", "index.js");

function run(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

// The exact contents of each surface tarball. publint proves the manifest's
// paths exist and attw proves the types resolve, but neither refuses an
// extra file; a tarball is exactly this list or the check fails, so a file
// that slips beneath an allowed directory is met here, reviewed, and pinned.
// The runtime packages carry the same rule in scripts/check-packages.mjs.
export const EXPECTED_FILES = {
  '@obversa/source': [
    'package/LICENSE',
    'package/README.md',
    'package/assets/app.css',
    'package/assets/app.js',
    'package/assets/file-tree.mjs',
    'package/assets/icons.mjs',
    'package/assets/nav-segments.mjs',
    'package/assets/surface-client.d.mts',
    'package/assets/tsconfig.json',
    'package/bin/obversa-review.mjs',
    'package/package.json',
    'package/skills/review-diff/SKILL.md',
    'package/src/context-model.mjs',
    'package/src/contract.mjs',
    'package/src/diff.mjs',
    'package/src/git.mjs',
    'package/src/highlight-model.mjs',
    'package/src/highlight.mjs',
    'package/src/index.mjs',
    'package/src/lang.mjs',
    'package/src/nav-model.mjs',
    'package/src/navindex.mjs',
    'package/src/navoverlay.mjs',
    'package/src/page.mjs',
    'package/src/review-args.mjs',
    'package/src/review-cli.mjs',
    'package/src/review.mjs',
    'package/src/testing.mjs',
  ],
  '@obversa/surfacer': [
    'package/LICENSE',
    'package/README.md',
    'package/package.json',
    'package/src/claim-frames.mjs',
    'package/src/client.mjs',
    'package/src/handoff.mjs',
    'package/src/host.mjs',
    'package/src/index.mjs',
    'package/src/launcher.mjs',
    'package/src/sanitize.mjs',
    'package/src/server.mjs',
    'package/src/transfer.mjs',
  ],
};

// Pack one package directory and prove the tarball with both tools.
// Returns the failures, each a one-line reason; an empty array is a pass.
export function checkTarball(packageDir, { expectedFiles } = {}) {
  const failures = [];
  const destination = mkdtempSync(join(tmpdir(), "obversa-tarball-"));
  try {
    const packed = run([PNPM_CLI, "pack", "--pack-destination", destination], { cwd: packageDir });
    if (packed.status !== 0) {
      failures.push(`${packageDir}: pack failed: ${(packed.stderr || packed.stdout || "").trim().split("\n").at(-1)}`);
      return failures;
    }
    const tarballs = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      failures.push(`${packageDir}: expected one packed tarball, found ${tarballs.length}`);
      return failures;
    }
    const tarball = join(destination, tarballs[0]);
    if (expectedFiles) {
      const entries = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const actual = entries.stdout.split("\n").filter(Boolean).sort();
      const expected = [...expectedFiles].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const extra = actual.filter((entry) => !expected.includes(entry));
        const missing = expected.filter((entry) => !actual.includes(entry));
        failures.push(`${packageDir}: the tarball is not exactly the pinned file list${extra.length ? `; extra: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
      }
    }
    const lint = run([PUBLINT_CLI, tarball]);
    if (lint.status !== 0) {
      failures.push(`${packageDir}: publint: ${(lint.stdout || lint.stderr || "").trim()}`);
    }
    // The workspace packages are ESM-only by design: no require condition,
    // no node10 main fallback for subpaths. The esm-only profile holds them
    // to the modes they actually serve — ESM node16 and bundlers — instead
    // of failing them for CJS consumers they never claim. The surface
    // packages ship plain JavaScript with no declaration files yet, which
    // is a fact, not a wrong type: untyped resolution is ignored until a
    // declaration build ships types for them.
    // The tarball comes first: --ignore-rules is variadic and would swallow
    // a trailing path.
    const types = run([ATTW_CLI, tarball, "--format", "ascii", "--profile", "esm-only", "--ignore-rules", "untyped-resolution"]);
    if (types.status !== 0) {
      failures.push(`${packageDir}: attw: ${(types.stdout || types.stderr || "").trim()}`);
    }
    return failures;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

export function allowlistedDirectories(root = ROOT) {
  const allowlist = JSON.parse(readFileSync(join(root, "scripts", "publish-allowlist.json"), "utf8"));
  const byName = new Map(listWorkspacePackages(root).map(({ name, dir }) => [name, dir]));
  return allowlist.packages.map((name) => join(root, byName.get(name)));
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  const failures = [];
  const directories = allowlistedDirectories();
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts', 'publish-allowlist.json'), 'utf8'));
  for (const [index, directory] of directories.entries()) {
    failures.push(...checkTarball(directory, { expectedFiles: EXPECTED_FILES[allowlist.packages[index]] }));
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(`Tarball shape check passed for ${directories.length} publishable packages.`);
}
