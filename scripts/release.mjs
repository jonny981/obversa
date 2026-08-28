#!/usr/bin/env node
// The supported way a package reaches the real registry.
//
// Every public manifest names a registry that never resolves, so a publish
// that skips the guard — a directory publish with scripts ignored, a prepared
// tarball, which runs no hook — goes nowhere unless the registry is overridden
// on purpose. This command runs the guard first (checkHook: OBVERSA_RELEASE=1,
// the allowlist, main, a clean tree, the annotated release tag) on exactly one
// listed public workspace package directory, and only then publishes that
// directory with the registry overridden to the real one; pnpm runs the
// prepublishOnly hook inside that publish as well.
//
// Usage: OBVERSA_RELEASE=1 node scripts/release.mjs packages/<name> [--dry-run]
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_REGISTRY, checkHook, listWorkspacePackages } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The plan for one release, or a thrown reason: the target must be, by real
// path, the directory of exactly one non-private workspace package (never a
// path outside the workspace, a private package, or a host), the flags may
// only be --dry-run, and the guard must pass. Pure apart from its inputs, so
// the spec can hold it to that.
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
  return { name: match.name, cwd, command: "pnpm", args: ["publish", "--registry", RELEASE_REGISTRY, "--access", "public", ...flags] };
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const [target, ...flags] = process.argv.slice(2);
  let plan;
  try {
    plan = releasePlan({ target, flags });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  if (plan) {
    const result = spawnSync(plan.command, plan.args, { cwd: plan.cwd, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}
