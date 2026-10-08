# Releasing

This guide describes how the release owner verifies and publishes the 22
Obversa packages.

## Versions, changelogs and tags

Changesets manages package versions, package changelogs and package tags. Add a
changeset with `pnpm changeset`. Run `pnpm changeset version` to apply compatible
version changes before review.

A new package sets its first version in its own manifest, with its first
changelog entry written by hand, and no changeset. A changeset would move the
version past that first number before the first publish.

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

The publishable set is `scripts/publish-allowlist.json` (23 packages). Eight
public packages use `packages/<name>`; fifteen plugin packages use
`plugins/<name>`. The audit, tarball check, publish workflow and registry check
all read that list. Publishing a package tags it `name@version`. There is no
repository-wide release tag.

## Release path

`.github/workflows/release.yml` is the guarded path to the npm registry. It runs
only through a manual dispatch on `main`.

Before the first dispatch, create the repository environment `release` and add
Jonny as its required reviewer. Do not dispatch the workflow until that setup
is complete.

The workflow has one job, `publish`. It runs these steps in order:

1. **Approve the release.** The job enters the configured `release`
   environment and waits for the required reviewer's approval.
2. **Check the release commit.** After it installs the frozen lockfile, the job
   runs `node scripts/check-release-commit.mjs`. See the next section.
3. **Build the publish checkout.** The job builds the complete workspace.
4. **Check the publish client.** The job proves it uses the root-pinned npm
   devDependency through pnpm's `npm-path` setting. It also checks the Node.js
   version needed by npm trusted publishing.
5. **Publish missing versions.** `pnpm changeset publish` runs each package's
   `prepublishOnly` guard, packs the package and sends it through the pinned npm
   client. Versions already on the registry are skipped.
6. **Push only existing intended tags.** The job pushes each allowlisted
   `name@version` tag as an exact ref. Before the publish, the job lists the
   tags that exist. A tag that is not in that list was created by this run's
   publish, so the job pushes it at once. The job pushes any other tag only
   when the registry shows its version. The job never creates a missing tag
   because the registry cannot prove which commit published that version. A
   missing tag stops the release with instructions to tag the original publish
   commit. A push that fails is tried twice more, five seconds apart, before it
   stops the release.

The job does not wait for npm to show the new versions. npm can take several
minutes to show a version after a publish. When the job passes, confirm the
release: read every allowlisted name and manifest version back from the
explicit npm registry.

```bash
node scripts/verify-published.mjs
```

The check asks again every five seconds, for up to ten minutes, for each
version that npm does not show yet. The release is complete only when every
version reads back.

The publish job carries `id-token: write` for npm trusted publishing. Each npm
package must name this repository, `release.yml` and the `release` environment
as its trusted publisher.

## The release commit check

The release workflow publishes a release commit. A release commit holds only
what `pnpm changeset version` and the docs package table write. The check
passes only when all of these are true:

- **One parent.** The commit is not a merge.
- **Only release files.** The commit changes only these paths:
  - `version` and workspace dependency versions in
    `packages/*/package.json` and `plugins/*/package.json`. Every other field
    stays the same.
  - `packages/*/CHANGELOG.md` and `plugins/*/CHANGELOG.md`.
  - `docs/public/packages/index.mdx`, the package table.
  - Deleted `.changeset/*.md` files. The check refuses a changeset that is
    added or changed.
- **The parent passed CI.** GitHub has a completed, successful run of the `CI`
  workflow on the parent commit. The check reads it through the GitHub API with
  the token in `GITHUB_TOKEN` or `GH_TOKEN`.

The release commit does not need a second run of the proof chain. Every change
reaches `main` only after the whole CI job passes on its exact tree. The parent
passed CI, and the release commit changes no code.

Each failure names the path, the field or the reason. A release commit that
fails the check stops the job before anything builds or publishes.

CI runs on each push to `main`, and a newer push cancels a run that is not
finished. Push the commit that holds the code and the changesets, and wait for
its CI run to pass. Then make the release commit on top of it and push that.

To run the check yourself before you push:

```bash
GH_TOKEN=<token> node scripts/check-release-commit.mjs HEAD
```

## First publish

A trusted publisher cannot be configured before a package exists. The first
release therefore needs a credential Jonny controls. Set the `NPM_TOKEN`
repository secret for the guarded workflow, or publish once from a clean `main`
checkout with Jonny's npm login:

```bash
pnpm build && \
  OBVERSA_RELEASE=1 pnpm changeset publish && \
  node scripts/tag-published.mjs && \
  node scripts/verify-published.mjs
```

The tag script pushes each package tag created by that publish as an explicit
ref. It never uses `git push --tags`.

After the first release, configure trusted publishing for every package and
disable token publishing for those packages.

## If a release fails

- **The release commit check refuses.** Do not publish. If the release
  commit changes code, land the code change through a normal stage first, so
  that it passes CI on `main`. Then run `pnpm changeset version` again on top
  of it and dispatch the release on the new release commit. If the parent has
  no successful CI run, wait for its run to pass, or re-run a cancelled one.
  If CI never ran on the parent, push the parent on its own and let CI pass,
  then make the release commit again.
- **Publishing stops partway.** Run the same workflow again. Changesets skips
  versions already on the registry. Existing intended tags are pushed again.
- **A package is published without its tag.** Find the commit that published
  it. Create `name@version` at that commit and push that exact tag ref. Never
  create the tag at a later `main` commit.
- **A tag push fails three times.** The tag exists only on the runner, so it
  is gone when the job ends. The package is published. Create the annotated
  tag at the commit the release's other tags point at, then push that exact
  tag ref.
- **Registry verification fails.** Do not call the release complete. Check the
  named package and version, then run the same registry check again.

## Publish guard

Every public package keeps the exact `prepublishOnly` guard and
`publishConfig.access: public`. Every package that builds output also runs a
read-only `prepack` check. It refuses missing or changed build output and source
or build configuration changed after the last successful root `pnpm build`. It
does not compile, clean or write files. The record covers the workspace source,
package manifests, TypeScript and tsup configuration, root build configuration,
lockfile and every built `dist` file. It does not claim to cover arbitrary tool
environment changes or published assets that no package build reads.

A public manifest carries no registry key. The audit refuses unlisted public
packages, missing guards, registry routes and alternate publish directories.

The guard allows a publish only when `OBVERSA_RELEASE=1` is set, the package is
allowlisted, the tree is clean and the checkout is `main` or the release
workflow. A tarball publish and a directory publish with `--ignore-scripts` do
not run the hook. Registry credentials and the configured release environment
control those deliberate paths.
