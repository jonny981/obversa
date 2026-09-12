// publint and @arethetypeswrong/cli on every packed public tarball.
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
// scripts/check-packages.mjs reads the same map, so every publishable
// package is pinned here: the runtime, engine and memory interfaces, their
// plugins, the runner, the review surfaces, and the ready-made teams package.
// Source maps and the public testing entry points ship on purpose.
export const EXPECTED_FILES = {
  '@obversa/runner': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/supervised-checkpoint.d.ts',
    'package/dist/supervised-engines.d.ts',
    'package/dist/supervised-record.d.ts',
    'package/dist/supervised-run.d.ts',
    'package/dist/supervised-status.d.ts',
    'package/dist/supervised-worker.d.ts',
    'package/dist/supervised-worker.js',
    'package/dist/supervised-worker.js.map',
    'package/package.json',
  ],
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
    'package/dist/bin/obversa-review.d.mts',
    'package/dist/src/context-model.d.mts',
    'package/dist/src/contract.d.mts',
    'package/dist/src/diff.d.mts',
    'package/dist/src/git.d.mts',
    'package/dist/src/highlight-model.d.mts',
    'package/dist/src/highlight.d.mts',
    'package/dist/src/index.d.mts',
    'package/dist/src/lang.d.mts',
    'package/dist/src/nav-model.d.mts',
    'package/dist/src/navindex.d.mts',
    'package/dist/src/navoverlay.d.mts',
    'package/dist/src/page.d.mts',
    'package/dist/src/review-args.d.mts',
    'package/dist/src/review-cli.d.mts',
    'package/dist/src/review.d.mts',
    'package/dist/src/testing.d.mts',
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
    'package/dist/claim-frames.d.mts',
    'package/dist/client.d.mts',
    'package/dist/handoff.d.mts',
    'package/dist/host.d.mts',
    'package/dist/index.d.mts',
    'package/dist/launcher.d.mts',
    'package/dist/sanitize.d.mts',
    'package/dist/server.d.mts',
    'package/dist/transfer.d.mts',
  ],
  '@obversa/runtime': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/api.d.ts',
    'package/dist/api.js',
    'package/dist/api.js.map',
    'package/dist/artifacts/conformance.d.ts',
    'package/dist/artifacts/file-store.d.ts',
    'package/dist/artifacts/store.d.ts',
    'package/dist/callback/approval.d.ts',
    'package/dist/callback/client.d.ts',
    'package/dist/callback/gate.d.ts',
    'package/dist/callback/stored-client.d.ts',
    'package/dist/workspace/conformance.d.ts',
    'package/dist/workspace/git-provider.d.ts',
    'package/dist/workspace/provider.d.ts',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/core/agent-md.d.ts',
    'package/dist/core/agent.d.ts',
    'package/dist/core/assert-graph.d.ts',
    'package/dist/core/budget.d.ts',
    'package/dist/core/concurrency.d.ts',
    'package/dist/core/condition.d.ts',
    'package/dist/core/context.d.ts',
    'package/dist/core/cost.d.ts',
    'package/dist/core/dag.d.ts',
    'package/dist/core/decision.d.ts',
    'package/dist/core/describe.d.ts',
    'package/dist/core/engine-meta.d.ts',
    'package/dist/core/env-overlay.d.ts',
    'package/dist/core/errors.d.ts',
    'package/dist/core/feedback.d.ts',
    'package/dist/core/git.d.ts',
    'package/dist/core/guards.d.ts',
    'package/dist/core/isolated.d.ts',
    'package/dist/core/job.d.ts',
    'package/dist/core/limits.d.ts',
    'package/dist/core/loop.d.ts',
    'package/dist/core/merge.d.ts',
    'package/dist/core/pipeline.d.ts',
    'package/dist/core/process.d.ts',
    'package/dist/core/progress.d.ts',
    'package/dist/core/redact.d.ts',
    'package/dist/core/stats.d.ts',
    'package/dist/core/team.d.ts',
    'package/dist/core/text.d.ts',
    'package/dist/core/tournament.d.ts',
    'package/dist/core/types.d.ts',
    'package/dist/engines/command-runner.d.ts',
    'package/dist/engines/conformance.d.ts',
    'package/dist/engines/engine.d.ts',
    'package/dist/engines/failure.d.ts',
    'package/dist/engines/fallback.d.ts',
    'package/dist/engines/message-map.d.ts',
    'package/dist/engines/mock.d.ts',
    'package/dist/engines/preflight.d.ts',
    'package/dist/env/command.d.ts',
    'package/dist/env/command.js',
    'package/dist/env/command.js.map',
    'package/dist/env/environment.d.ts',
    'package/dist/env/mock.d.ts',
    'package/dist/events/conformance.d.ts',
    'package/dist/events/envelope.d.ts',
    'package/dist/events/jsonl-store.d.ts',
    'package/dist/events/store.d.ts',
    'package/dist/graph/commands.d.ts',
    'package/dist/graph/conformance.d.ts',
    'package/dist/graph/kernel.d.ts',
    'package/dist/graph/plan.d.ts',
    'package/dist/graph/type.d.ts',
    'package/dist/graph/value.d.ts',
    'package/dist/graph-types/dag.d.ts',
    'package/dist/graph-types/loop.d.ts',
    'package/dist/graph-types/team.d.ts',
    'package/dist/proof/acceptance.d.ts',
    'package/dist/proof/artifact.d.ts',
    'package/dist/proof/cache.d.ts',
    'package/dist/runtime/attempt.d.ts',
    'package/dist/runtime/budget.d.ts',
    'package/dist/runtime/engine-availability.d.ts',
    'package/dist/runtime/graph-executor.d.ts',
    'package/dist/runtime/node-lifecycle.d.ts',
    'package/dist/runtime/paths.d.ts',
    'package/dist/runtime/persist.d.ts',
    'package/dist/runtime/preflight-record.d.ts',
    'package/dist/runtime/process-tree.d.ts',
    'package/dist/runtime/result-contract.d.ts',
    'package/dist/runtime/result-parts.d.ts',
    'package/dist/runtime/run-definition.d.ts',
    'package/dist/runtime/run-event.d.ts',
    'package/dist/runtime/runner.d.ts',
    'package/dist/runtime/supervisor.d.ts',
    'package/dist/runtime/team-rooms.d.ts',
    'package/dist/runtime/workspace-policy.d.ts',
    'package/dist/storage/error.d.ts',
    'package/dist/storage/id.d.ts',
    'package/dist/storage/local.d.ts',
    'package/dist/storage/local.js',
    'package/dist/storage/local.js.map',
    'package/dist/testing.d.ts',
    'package/dist/testing.js',
    'package/dist/testing.js.map',
    'package/package.json',
  ],
  '@obversa/engine': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/chunk-*.js',
    'package/dist/chunk-*.js.map',
    'package/dist/claude-stream-json.d.ts',
    'package/dist/command.js',
    'package/dist/command.js.map',
    'package/dist/command/attempt-env.d.ts',
    'package/dist/command/process-tree.d.ts',
    'package/dist/command/retry-after.d.ts',
    'package/dist/command/run.d.ts',
    'package/dist/command/scrub.d.ts',
    'package/dist/conformance.d.ts',
    'package/dist/contracts.d.ts',
    'package/dist/error.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/json.d.ts',
    'package/dist/result.d.ts',
    'package/dist/testing.d.ts',
    'package/dist/testing.js',
    'package/dist/testing.js.map',
    'package/package.json',
  ],
  '@obversa/engine-agent-sdk': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/agent-sdk.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/engine-anthropic-api': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/anthropic-api.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/engine-claude-cli': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/claude-cli.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/engine-codex': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/codex.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/engine-grok-cli': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/grok-cli.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/engine-opencode-cli': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/opencode-cli.d.ts',
    'package/package.json',
  ],
  '@obversa/memory': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/mechanics.d.ts',
    'package/dist/testing.d.ts',
    'package/dist/testing.js',
    'package/dist/testing.js.map',
    'package/dist/types.d.ts',
    'package/package.json',
  ],
  '@obversa/memory-git': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/git-memory.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/memory-simple': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/process': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/package.json',
  ],
  '@obversa/teams': [
    'package/LICENSE',
    'package/README.md',
    'package/dist/agent-response.d.ts',
    'package/dist/feature-delivery.d.ts',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/team-utils.d.ts',
    'package/dist/threshold-panel.d.ts',
    'package/dist/types.d.ts',
    'package/dist/writer-reviewer-pair.d.ts',
    'package/package.json',
  ],
};

// Pack one package directory and prove the tarball with both tools.
// Returns the failures, each a one-line reason; an empty array is a pass.
// tsup names shared chunks by content hash, so the hash changes with every
// edit to the code. The pinned lists name those files chunk-*.js and the
// comparison strips the hash from the packed names, so the number of chunks
// and their maps stay pinned while their hashes do not.
export function withoutChunkHash(entry) {
  return entry.replace(/chunk-[A-Z0-9]{8}\.js/, "chunk-*.js");
}

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
      const actual = entries.stdout.split("\n").filter(Boolean).map(withoutChunkHash).sort();
      const expected = [...expectedFiles].map(withoutChunkHash).sort();
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
  return allowlist.packages.map((name) => {
    const directory = byName.get(name);
    if (directory === undefined) throw new Error(`${name} is on the allowlist but is not a workspace package`);
    return join(root, directory);
  });
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  const failures = [];
  const directories = allowlistedDirectories();
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts', 'publish-allowlist.json'), 'utf8'));
  for (const [index, directory] of directories.entries()) {
    const name = allowlist.packages[index];
    if (!Object.hasOwn(EXPECTED_FILES, name)) {
      failures.push(`${name}: missing pinned file list`);
      continue;
    }
    failures.push(...checkTarball(directory, { expectedFiles: EXPECTED_FILES[name] }));
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(`Tarball shape check passed for ${directories.length} publishable packages.`);
}
