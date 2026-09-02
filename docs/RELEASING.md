# Releasing

This guide describes how a version of the Obversa packages is cut, who
approves it, and what the automation does.

## Who can release

Only Jonny approves a release. The publish job in the Release workflow
runs inside a protected GitHub environment named `release`. That
environment requires a manual approval from Jonny before any step runs.
No code path publishes without that approval.

Set up the environment before the first tag: in the repository settings,
create an environment named `release`, add Jonny as a required reviewer,
and restrict the environment to `v*` tags. GitHub creates a missing
environment with no reviewers, so the setup must happen first.

## The version numbers

| Package | Version at v1.0.0 |
|---------|-------------------|
| `@obversa/runtime` | 1.0.0 |
| `@obversa/engine` | 0.1.0 |
| `@obversa/memory` | 0.1.0 |
| `@obversa/memory-simple` | 0.1.0 |
| `@obversa/memory-git` | 0.1.0 |
| `@obversa/surfacer` | 0.1.0 |
| `@obversa/source` | 0.1.0 |
| Engine plugins (six) | 0.1.0 each |

The repository carries one tag for the release: `v1.0.0`. The tag name
matches the runtime version. Every other package tracks its own version
in its own `package.json`.

## The steps

1. **Update the changelog.** Open `CHANGELOG.md`. Retitle the
   `Unreleased` section to the new version with a date. The changelog
   gate refuses to publish a version the changelog does not describe.

2. **Set the versions.** Set each package's `version` field in its
   `package.json`. The root `package.json` stays at `0.0.0` because the
   root is a workspace, not a package.

3. **Verify the tree.** Run `pnpm verify:d2` (or the chain closest to
   what changed). Every check must pass before a release is cut.

4. **Tag the repository.** Create the tag and push it:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

5. **Approve the release.** GitHub sends a request to the `release`
   environment. Jonny approves it in the GitHub interface.

6. **The workflow runs.** The Release workflow:

   - Verifies the full chain: both typechecks, build, tests, boundaries,
     graph purity, tarballs, package manifests, publish audit, clean
     consumer, and the documentation build.
   - Runs the changelog gate.
   - Packs all 13 allowlisted packages.
   - Publishes each package to npm with provenance.
   - Creates the GitHub Release with the changelog section as the body.

7. **The guard registry.** Each package's `package.json` carries a
   `publishConfig` that points at a registry that does not exist. This
   prevents a hand publish from a local checkout. The Release workflow
   passes `--registry` to `npm publish`, which routes around the guard on
   the clean runner. The guard stays for local proofs.

## What the changelog gate checks

The gate (`scripts/changelog-gate.mjs`) reads the version from the
runtime `package.json` and checks that `CHANGELOG.md` has a heading for
that version with at least one entry. It also checks that the tag name
matches the version. A version without a changelog entry does not
publish.

## What happens if the workflow stops

Every publish step is idempotent. A package that is already on npm is
skipped. A GitHub Release that already exists is left alone. A workflow
that stopped partway completes on the next tag push.
