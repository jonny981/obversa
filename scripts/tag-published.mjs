// Release tags for published versions. `changeset publish` tags each package
// it publishes in a run (`name@version`, at the commit it packed). This step
// pushes every intended tag that exists — explicitly, by name — and refuses
// the rest.
//
// What it never does is create a missing tag: the registry can prove a
// version is published, but nothing here can prove HEAD is the commit that
// published it — on a retried run `main` may have moved. Inventing the tag
// at HEAD would falsify the release record, so a missing tag fails with the
// recovery below instead.
//
// The registry is explicit and git comes from the system directories, the
// same hardening as the publish guard: no ambient npmrc destination, no
// PATH-supplied git. Run in the release workflow after `changeset publish`;
// the same command pushes tags for a local manual publish.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_REGISTRY, gitBin, listWorkspacePackages, readAllowlist } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Published is decided by the registry, not by the run's log: a retried
// publish skips versions already there and reports nothing about them.
function registryHas(npm, registry, name, version) {
  const result = spawnSync(npm, ["view", `${name}@${version}`, "--registry", registry, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return { published: false, reason: result.error?.message ?? ((result.stderr ?? "").trim() || `exit ${result.status}`) };
  return { published: result.stdout.trim() === version, reason: `registry answered "${result.stdout.trim() || "nothing"}"` };
}

function git(run, cwd, ...args) {
  const result = run(gitBin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, out: ((result.stdout ?? "") + (result.stderr ?? "")).trim() };
}

export function tagPublished({ npm = process.env.npm_config_npm_path ?? "npm", registry = RELEASE_REGISTRY, root = ROOT, allowlist = readAllowlist(), run = spawnSync, remote = "origin" } = {}) {
  const byName = new Map(listWorkspacePackages(root).map((p) => [p.name, p]));
  const problems = [];
  const pushed = [];
  for (const name of allowlist) {
    const p = byName.get(name);
    if (!p?.version) {
      problems.push(`${name}: ${p ? "the manifest has no version" : "on the allowlist but not a workspace package"}`);
      continue;
    }
    const tag = `${name}@${p.version}`;
    const { published, reason } = registryHas(npm, registry, name, p.version);
    if (!published) {
      problems.push(`${tag}: not on the registry (${reason}); there is nothing to push`);
      continue;
    }
    if (!git(run, root, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) {
      problems.push(`${tag}: published but the tag does not exist locally — a retried publish skipped creating it. Tag the commit that published this version, never a moved HEAD: git tag ${tag} <publish-commit> && git push ${remote} refs/tags/${tag}`);
      continue;
    }
    const push = git(run, root, "push", remote, `refs/tags/${tag}`);
    if (!push.ok) {
      problems.push(`${tag}: push failed (${push.out})`);
      continue;
    }
    pushed.push(tag);
  }
  return { pushed, problems };
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const { pushed, problems } = tagPublished();
  for (const tag of pushed) console.log(`tag published: ${tag}`);
  if (problems.length) {
    for (const p of problems) console.error(`tag published: ${p}`);
    process.exit(1);
  }
}
