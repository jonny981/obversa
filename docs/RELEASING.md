# Releasing

This guide describes how Jonny verifies and publishes a version of the
Obversa packages.

## The version numbers

The release has one repository tag, `v1.0.0`. The runtime package uses that
version. Every other public package keeps its own version in its manifest.
The package list comes from `scripts/publish-allowlist.json`; the tarball
check and release script read that same list.

When only plugin code changes, also increase the runtime PATCH version in
`packages/runtime/package.json`, for example from `1.0.0` to `1.0.1`. The
publish guard requires the repository tag to match that runtime version,
including when publishing a plugin. Add the plugin changes under the heading
for the new runtime version in `CHANGELOG.md`, then verify and create the new
annotated tag, for example `v1.0.1`. Bump the changed plugin's own version too.

## The steps

1. **Update the changelog.** Add the release heading and entries to
   `CHANGELOG.md`. The changelog gate refuses a release without them.

2. **Set package versions.** Update each allowlisted package manifest. The
   workspace root remains private and is never published.

3. **Verify the exact commit.** Run the stage chain, which includes the
   tarball check and changelog gate:

   ```bash
   pnpm verify:d15
   ```

4. **Create one repository tag.** Tag the gate-passed commit and push it:

   ```bash
   git tag -a v1.0.0 -m 'release v1.0.0'
   git push origin v1.0.0
   ```

5. **Read the workflow record.** The `Release` workflow runs `pnpm verify:d15`,
   including the tarball check and changelog gate. It never publishes packages.

6. **Approve the destination.** Jonny names the real npm registry before
   publishing. No publish command runs without that approval.

7. **Publish through the guarded script.** Run the script once for each name
   in `scripts/publish-allowlist.json` from a clean `main` checkout at the
   repository tag. Six public packages use `packages/<name>`; eight plugin
   packages use `plugins/<name>` (six engine adapters and two memory adapters):

   ```bash
   OBVERSA_RELEASE=1 node scripts/release.mjs packages/runtime
   OBVERSA_RELEASE=1 node scripts/release.mjs plugins/engine-codex
   ```

   The script checks the repository tag and clean tree, packs one allowlisted
   package, checks the tree again, and publishes its tarball. It supplies both
   npm registry keys, pointing to the one approved destination, so the two
   sentinel values in each package manifest are displaced together.

## The publish guard

Each public manifest carries a never-resolving registry under both `registry`
and `@obversa:registry`. A directory or tarball publish targets that guard
unless the caller explicitly overrides both registry keys. The release
script supplies both matching overrides.

## What happens if verification fails

Do not publish. Fix the failing check, rerun the full stage chain at the same
scope, and use the same gate-passed commit for the repository tag.
