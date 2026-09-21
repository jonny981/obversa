# Releasing

This guide describes how the release owner verifies and publishes the 18
Obversa packages.

## Versions, changelogs and tags

Changesets manages package versions, package changelogs and package tags. Add a
changeset with `pnpm changeset`. Run `pnpm changeset version` to apply compatible
version changes before review.

The four core packages share one version through the fixed group in
`.changeset/config.json`:

- `@obversa/api`
- `@obversa/core`
- `@obversa/runtime`
- `@obversa/runner`

References between those four packages are exact. `@obversa/runtime` keeps
`@obversa/api` as a peer dependency.

Every other public package versions independently. Before 1.0, a breaking
public-contract change takes a minor bump. A compatible addition or fix takes a
patch bump.

A core minor needs deliberate preparation because every exact core reference
must move together. Set all four versions and their internal references, update
their changelogs and the lockfile, then run the full release checks and the
packed consumer check. Complete one worked core-minor check before the first
core minor release. Stock `changeset publish` still performs the publish.

The publishable set is `scripts/publish-allowlist.json` (18 packages). Eight
public packages use `packages/<name>`; ten plugin packages use
`plugins/<name>`. The audit, tarball check, publish workflow and registry check
all read that list. Publishing a package tags it `name@version`. There is no
repository-wide release tag.

## Release path

`.github/workflows/release.yml` is the guarded path to the npm registry. It runs
only through a manual dispatch on `main`.

Before the first dispatch, create the repository environment `release` and add
Jonny as its required reviewer. Do not dispatch the workflow until that setup
is complete.

1. **Verify the source.** The `verify` job runs `pnpm verify:d15`.
2. **Approve the release.** The `publish` job enters the configured `release`
   environment and waits for Jonny's approval.
3. **Build the publish checkout.** The publish job installs the frozen lockfile
   and builds the complete workspace. It does not reuse files from the verify
   job.
4. **Check the publish client.** The job proves it uses the root-pinned npm
   devDependency through pnpm's `npm-path` setting. It also checks the Node.js
   version needed by npm trusted publishing.
5. **Publish missing versions.** `pnpm changeset publish` runs each package's
   `prepublishOnly` guard, packs the package and sends it through the pinned npm
   client. Versions already on the registry are skipped.
6. **Push only existing intended tags.** The job pushes each allowlisted
   `name@version` tag as an exact ref. It never creates a missing tag because
   the registry cannot prove which commit published that version. A missing tag
   stops the release with instructions to tag the original publish commit.
7. **Read the registry back.** `scripts/verify-published.mjs` asks the explicit
   npm registry for every allowlisted name and manifest version.

The publish job carries `id-token: write` for npm trusted publishing. Each npm
package must name this repository, `release.yml` and the `release` environment
as its trusted publisher.

## First publish

A trusted publisher cannot be configured before a package exists. The first
release therefore needs a credential Jonny controls. Set the `NPM_TOKEN`
repository secret for the guarded workflow, or publish once from a clean `main`
checkout with Jonny's npm login:

```bash
OBVERSA_RELEASE=1 pnpm changeset publish
node scripts/tag-published.mjs
node scripts/verify-published.mjs
```

The tag script pushes each package tag created by that publish as an explicit
ref. It never uses `git push --tags`.

After the first release, configure trusted publishing for every package and
disable token publishing for those packages.

## If a release fails

- **Verification fails.** Do not publish. Fix the failure and run the full
  release checks again.
- **Publishing stops partway.** Run the same workflow again. Changesets skips
  versions already on the registry. Existing intended tags are pushed again.
- **A package is published without its tag.** Find the commit that published
  it. Create `name@version` at that commit and push that exact tag ref. Never
  create the tag at a later `main` commit.
- **A tag push fails.** Push that existing exact tag ref again.
- **Registry verification fails.** Do not call the release complete. Check the
  named package and version, then run the same registry check again.

## Publish guard

Every public package keeps the exact `prepublishOnly` guard and
`publishConfig.access: public`. A public manifest carries no registry key. The
audit refuses unlisted public packages, missing guards, registry routes and
alternate publish directories.

The guard allows a publish only when `OBVERSA_RELEASE=1` is set, the package is
allowlisted, the tree is clean and the checkout is `main` or the release
workflow. A tarball publish and a directory publish with `--ignore-scripts` do
not run the hook. Registry credentials and the configured release environment
control those deliberate paths.
