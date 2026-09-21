// Post-publish verification: every allowlisted package's manifest version
// must resolve on the release registry. The release workflow runs it after
// `changeset publish`; the same check closes a manual publish.
//
// The registry is passed explicitly — an ambient user npmrc could name
// another destination, and this check exists to prove the real one answered.
// `npm view <name>@<version>` exits 0 with empty output for a missing
// version, so the check reads the answer, not just the exit code. The npm it
// asks is npm_config_npm_path when set — the pinned publish client in CI —
// and otherwise the npm on PATH; a read query needs no credentials.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_REGISTRY, listWorkspacePackages, readAllowlist } from "./check-publish-allowlist.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function verifyPublished({ npm = process.env.npm_config_npm_path ?? "npm", registry = RELEASE_REGISTRY, root = ROOT, allowlist = readAllowlist() } = {}) {
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
    const result = spawnSync(npm, ["view", `${name}@${p.version}`, "--registry", registry, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const resolved = (result.stdout ?? "").trim();
    if (result.error) {
      problems.push(`${name}@${p.version}: the registry query could not run (${result.error.message})`);
    } else if (result.status !== 0) {
      problems.push(`${name}@${p.version}: the registry query failed (${(result.stderr ?? "").trim() || `exit ${result.status}`})`);
    } else if (resolved !== p.version) {
      problems.push(`${name}@${p.version}: not on the registry (registry answered "${resolved || "nothing"}")`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const problems = verifyPublished();
  if (problems.length) {
    for (const p of problems) console.error(`verify published: ${p}`);
    process.exit(1);
  }
  console.log(`verify published: all ${readAllowlist().size} allowlisted versions are on ${RELEASE_REGISTRY}`);
}
