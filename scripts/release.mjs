#!/usr/bin/env node
// The supported way a package reaches the real registry.
//
// Every public manifest names a registry that never resolves under both keys
// npm consults for a scoped name (`registry` and `@obversa:registry`), so a
// publish that skips the guard — a directory publish with scripts ignored, a
// prepared tarball, which runs no hook — goes nowhere unless both keys are
// overridden on purpose. This command runs the guard (checkHook:
// OBVERSA_RELEASE=1, the allowlist, main, a clean tree, the annotated release
// tag) on exactly one listed public workspace package directory, packs it
// with pnpm (which rewrites workspace versions into the tarball), runs the
// guard AGAIN on the packed state — a pack step that changed a tracked file
// leaves a dirty tree and is refused before npm is ever started — and then
// publishes that tarball with npm, overriding both registry keys on the
// command line, the one place npm lets a flag beat the manifest's
// publishConfig. A dry run (`--dry-run`) does all of that and lets npm report
// the registry it would publish to without publishing.
//
// SIGINT and SIGTERM are forwarded to whichever child is running, the child's
// exit is awaited, and the temporary pack directory is removed on every path.
//
// Usage: OBVERSA_RELEASE=1 node scripts/release.mjs packages/<name> [--dry-run]
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_REGISTRY, SCOPE_REGISTRY_KEY, checkHook, listWorkspacePackages } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The npm that publishes: the copy pinned as a root devDependency, resolved
// through the module resolver from this file — never whichever npm is first
// on PATH — and run under the current node. The publish guard's spec reads
// npm's registry rules from the same copy.
export const NPM_DIR = dirname(createRequire(import.meta.url).resolve("npm/package.json"));
export const NPM_CLI = join(NPM_DIR, "bin", "npm-cli.js");
// The pnpm that packs: pinned the same way, resolved the same way, run under
// the current node — a substituted pnpm on PATH cannot produce the tarball
// npm publishes.
// pnpm's exports map exposes only its package.json, so the bare name resolves
// to that file and the directory is its parent.
export const PNPM_DIR = dirname(createRequire(import.meta.url).resolve("pnpm"));
export const PNPM_CLI = join(PNPM_DIR, "bin", "pnpm.cjs");

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
    pack: { command: process.execPath, args: [PNPM_CLI, "pack", "--pack-destination"] },
    publishArgs: (tarball) => publishArgs(tarball, flags),
  };
}

/** The npm command line that publishes a packed tarball to the real
 *  registry: both registry keys overridden as flags, so the sentinel in the
 *  tarball's manifest is stepped over deliberately and nowhere else. */
export function publishArgs(tarball, flags = [], registry = RELEASE_REGISTRY) {
  return ["publish", tarball, "--registry", registry, `--${SCOPE_REGISTRY_KEY}=${registry}`, "--access", "public", ...flags];
}

/**
 * Run one child to completion, forwarding SIGINT and SIGTERM from `signals`
 * (the process by default) and awaiting its exit. Resolves { code, signal };
 * rejects when the child cannot be started, so the failure is visible.
 */
export function runChild(command, args, { cwd, signals = process, stdio = "inherit", spawnImpl = spawn, killAfterMs = 5_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, { cwd, stdio });
    // The first signal is forwarded as itself. A child that has not exited
    // `killAfterMs` later, or a second signal, gets SIGKILL: a child that
    // ignores the forwarded signal cannot hold the release open, and the
    // caller's second press is never swallowed.
    let escalation;
    let forwarded = false;
    const kill = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
    const forward = (signal) => () => {
      if (forwarded) { kill("SIGKILL"); return; }
      forwarded = true;
      kill(signal);
      escalation = setTimeout(() => kill("SIGKILL"), killAfterMs);
      escalation.unref?.();
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    signals.on("SIGINT", onInt);
    signals.on("SIGTERM", onTerm);
    const done = () => {
      clearTimeout(escalation);
      signals.off("SIGINT", onInt);
      signals.off("SIGTERM", onTerm);
    };
    child.once("error", (error) => { done(); reject(error); });
    child.once("exit", (code, signal) => { done(); resolvePromise({ code, signal }); });
  });
}

/**
 * The release: pack under a temporary directory, run the guard again on the
 * packed state, publish, and remove the directory whatever happened.
 * Returns the exit code. `run`, `check`, and `mkdtemp` are injectable so the
 * spec can drive every path without a real pnpm or npm.
 */
export async function release(plan, { run = runChild, check = checkHook, mkdtemp = () => mkdtempSync(join(os.tmpdir(), "obversa-release-")), log = console.error, signals = process } = {}) {
  const destination = mkdtemp();
  try {
    const packed = await run(plan.pack.command, [...plan.pack.args, destination], { cwd: plan.cwd, signals });
    if (packed.signal) { log(`release: pnpm pack was stopped by ${packed.signal}`); return 1; }
    const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"));
    if (packed.code !== 0 || !tarball) { log(`release: pnpm pack failed for ${plan.name}`); return packed.code || 1; }
    // The pack step ran scripts (prepack, prepare). If it changed a tracked
    // file, the tree is no longer the tagged, clean state the guard passed:
    // refuse before npm is started.
    const problems = check({ cwd: plan.cwd });
    if (problems.length) { for (const problem of problems) log(`release: after pack, ${problem}`); return 1; }
    const published = await run(process.execPath, [NPM_CLI, ...plan.publishArgs(join(destination, tarball))], { cwd: plan.cwd, signals });
    if (published.signal) { log(`release: npm publish was stopped by ${published.signal}`); return 1; }
    return published.code ?? 1;
  } catch (error) {
    log(`release: ${error?.message ?? error}`);
    return 1;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
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
  if (plan) process.exitCode = await release(plan);
}
