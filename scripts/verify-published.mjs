// Post-publish verification: every allowlisted package's manifest version
// must resolve on the release registry. The release workflow runs it after
// `changeset publish`; the same check closes a manual publish.
//
// The registry is passed explicitly — an ambient user npmrc could name
// another destination, and this check exists to prove the real one answered.
// Each exact-version document must name the requested package and version.
// Public registry reads need no credentials.
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_REGISTRY, listWorkspacePackages, readAllowlist } from "./check-publish-allowlist.mjs";
import { readPublishedVersion } from "./read-published-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyPublished({ registry = RELEASE_REGISTRY, root = ROOT, allowlist = readAllowlist() } = {}) {
  const byName = new Map(listWorkspacePackages(root).map((p) => [p.name, p]));
  const problems = [];
  for (const name of allowlist) {
    const p = byName.get(name);
    if (!p) {
      problems.push(`${name}: on the allowlist but not a workspace package`);
      continue;
    }
    if (!p.version) {
      problems.push(`${name}: the manifest has no version to verify`);
      continue;
    }
    const { published, reason } = await readPublishedVersion(registry, name, p.version);
    if (!published) {
      problems.push(`${name}@${p.version}: not on the registry (${reason})`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const problems = await verifyPublished();
  if (problems.length) {
    for (const p of problems) console.error(`verify published: ${p}`);
    process.exit(1);
  }
  console.log(`verify published: all ${readAllowlist().size} allowlisted versions are on ${RELEASE_REGISTRY}`);
}
