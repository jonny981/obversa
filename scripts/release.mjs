#!/usr/bin/env node
// The supported way a package reaches the real registry.
//
// Every public manifest names a registry that never resolves under both keys
// npm consults for a scoped name (`registry` and `@obversa:registry`), so a
// publish that skips the guard — a directory publish with scripts ignored, a
// prepared tarball, which runs no hook — goes nowhere unless both keys are
// overridden on purpose. This command runs the guard first (checkHook:
// OBVERSA_RELEASE=1, the allowlist, main, a clean tree, the annotated release
// tag) on exactly one listed public workspace package directory, packs it
// with pnpm (which rewrites workspace versions into the tarball), and then
// publishes that tarball with npm, overriding both registry keys on the
// command line — the one place npm lets a flag beat the manifest's
// publishConfig. A dry run (`--dry-run`) packs and reports the registry npm
// would publish to, without publishing.
//
// Usage: OBVERSA_RELEASE=1 node scripts/release.mjs packages/<name> [--dry-run]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_REGISTRY, SCOPE_REGISTRY_KEY, checkHook, listWorkspacePackages } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The plan for one release, or a thrown reason: the target must be, by real
// path, the directory of exactly one non-private workspace package (never a
// path outside the workspace, a private package, or a host), the flags may
// only be --dry-run, and the guard must pass. Pure apart from its inputs, so
// the spec can hold it to that. `publishArgs(tarball)` is the exact npm
// command line for the packed archive.
export function releasePlan({ target, flags = [], root = ROOT, packages = listWorkspacePackages(root), check = checkHook } = {}) {
  if (typeof target !== "string" || target.length === 0) throw new Error("usage: OBVERSA_RELEASE=1 node scripts/release.mjs packages/<name> [--dry-run]");
  if (flags.some((flag) => flag !== "--dry-run")) throw new Error(`release: unknown flag ${flags.find((flag) => flag !== "--dry-run")}`);
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const cwd = real(resolve(root, target));
  const match = packages.find((p) => !p.private && real(join(root, p.dir)) === cwd);
  if (!cwd || !match) throw new Error(`release: ${target} is not the directory of a public workspace package`);
  const problems = check({ cwd });
  if (problems.length) throw new Error(problems.map((problem) => `release: ${problem}`).join("\n"));
  return {
    name: match.name,
    cwd,
    pack: { command: "pnpm", args: ["pack", "--pack-destination"] },
    publishArgs: (tarball) => publishArgs(tarball, flags),
  };
}

/** The npm command line that publishes a packed tarball to the real
 *  registry: both registry keys overridden as flags, so the sentinel in the
 *  tarball's manifest is stepped over deliberately and nowhere else. */
export function publishArgs(tarball, flags = [], registry = RELEASE_REGISTRY) {
  return ["publish", tarball, "--registry", registry, `--${SCOPE_REGISTRY_KEY}=${registry}`, "--access", "public", ...flags];
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const [target, ...flags] = process.argv.slice(2);
  if (target === "--help" || target === "-h") {
    console.log("Usage: OBVERSA_RELEASE=1 node scripts/release.mjs packages/<name> [--dry-run]");
    process.exit(0);
  }
  let plan;
  try {
    plan = releasePlan({ target, flags });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  if (plan) {
    const destination = mkdtempSync(join(os.tmpdir(), "obversa-release-"));
    try {
      const packed = spawnSync(plan.pack.command, [...plan.pack.args, destination], { cwd: plan.cwd, stdio: "inherit" });
      const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"));
      if (packed.status !== 0 || !tarball) {
        console.error(`release: pnpm pack failed for ${plan.name}`);
        process.exitCode = packed.status || 1;
      } else {
        const published = spawnSync("npm", plan.publishArgs(join(destination, tarball)), { cwd: plan.cwd, stdio: "inherit" });
        process.exitCode = published.status ?? 1;
      }
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  }
}
