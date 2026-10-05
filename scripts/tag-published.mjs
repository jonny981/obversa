// Release tags for published versions. `changeset publish` tags each package
// it publishes in a run (`name@version`, at the commit it packed). This step
// pushes every intended tag that exists — explicitly, by name — and refuses
// the rest.
//
// With `--tags-before <file>` (the output of `git tag --list` just before the
// publish), a tag that is not in that list was created by this run's publish:
// it is pushed at once, without reading the registry. Any other tag is pushed
// only once the registry shows its version, which can take minutes.
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
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_REGISTRY, gitBin, listWorkspacePackages, readAllowlist } from "./check-publish-allowlist.mjs";
import { readPublishedVersionWithRetry } from "./read-published-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(run, cwd, ...args) {
  const result = run(gitBin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, out: ((result.stdout ?? "") + (result.stderr ?? "")).trim() };
}

// A retried publish can skip existing versions, so a tag this run did not
// create is checked against the registry, not the publish log.
// GitHub sometimes rejects one ref of a run with a server error ("fatal
// error in commit_refs") while the next push of the same tag goes through, so
// a failed push is tried again before it counts as a failure.
const PUSH_ATTEMPTS = 3;

export async function tagPublished({ registry = RELEASE_REGISTRY, root = ROOT, allowlist = readAllowlist(), run = spawnSync, remote = "origin", retry, pushPauseMs = 5000, tagsBefore } = {}) {
  const byName = new Map(listWorkspacePackages(root).map((p) => [p.name, p]));
  const problems = [];
  const pushed = [];
  const hasTag = (tag) => git(run, root, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok;
  const pushTag = async (tag) => {
    let push = git(run, root, "push", remote, `refs/tags/${tag}`);
    for (let attempt = 1; !push.ok && attempt < PUSH_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, pushPauseMs));
      push = git(run, root, "push", remote, `refs/tags/${tag}`);
    }
    if (push.ok) pushed.push(tag);
    else problems.push(`${tag}: push failed (${push.out})`);
  };
  const entries = [...allowlist].map((name) => {
    const p = byName.get(name);
    const tag = p?.version ? `${name}@${p.version}` : undefined;
    return { name, p, tag, created: Boolean(tag && tagsBefore && !tagsBefore.has(tag) && hasTag(tag)) };
  });
  // Tags this run's publish created are pushed first, before any registry read.
  for (const { tag, created } of entries) if (created) await pushTag(tag);
  // Every other registry read runs at once; those tags are then pushed one by one in allowlist order.
  const reads = await Promise.all(entries.filter((e) => !e.created).map(async (e) => {
    if (!e.tag) return e;
    return { ...e, ...(await readPublishedVersionWithRetry(registry, e.name, e.p.version, retry)) };
  }));
  for (const { name, p, tag, published, reason } of reads) {
    if (!tag) {
      problems.push(`${name}: ${p ? "the manifest has no version" : "on the allowlist but not a workspace package"}`);
      continue;
    }
    if (!published) {
      problems.push(`${tag}: not on the registry (${reason}); there is nothing to push`);
      continue;
    }
    if (!hasTag(tag)) {
      problems.push(`${tag}: published but the tag does not exist locally — a retried publish skipped creating it. Tag the commit that published this version, never a moved HEAD: git tag ${tag} <publish-commit> && git push ${remote} refs/tags/${tag}`);
      continue;
    }
    await pushTag(tag);
  }
  return { pushed, problems };
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const flag = process.argv.indexOf("--tags-before");
  const tagsBefore = flag === -1 ? undefined : new Set(readFileSync(process.argv[flag + 1], "utf8").split("\n").filter(Boolean));
  const { pushed, problems } = await tagPublished({ tagsBefore });
  for (const tag of pushed) console.log(`tag published: ${tag}`);
  if (problems.length) {
    for (const p of problems) console.error(`tag published: ${p}`);
    process.exit(1);
  }
}
