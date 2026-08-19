# Release runbook

This repository publishes beta versions of `@payops/wdk-solana` from reviewed,
version-matched Git tags. Do not publish from a local working tree.

## Preconditions

1. Merge the release pull request after all required checks pass.
2. Confirm the `npm-release` environment requires manual approval and permits
   only protected release tags.
3. Confirm npm trusted publishing points to `payops-labs/payops-wdk-solana`,
   `.github/workflows/release.yml`, and the `npm-release` environment. Do not
   add a long-lived npm token.
4. Confirm the package version is a numbered beta such as `0.1.0-beta.1`.

## Create the release

From a fresh checkout of `main`, record the reviewed merge commit and run:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm release:verify
git status --short
git tag -a v<VERSION> -m "PayOps WDK Solana v<VERSION>" <MERGED_SHA>
git push origin v<VERSION>
```

Approve the protected environment only after GitHub shows the expected tag,
commit, and workflow. The workflow rejects stable or mismatched tags, reruns the
complete release gate, publishes with npm provenance under the `beta` tag, and
then creates the GitHub release.

## Verify the registry result

After publication, inspect the public registry metadata and install into a new
temporary project:

```bash
npm view @payops/wdk-solana@beta --json
npm install @payops/wdk-solana@beta
```

Confirm the version, public access, provenance, repository links, dependency
ranges, and package files. Record the workflow, GitHub release, npm package, tag
object, and merge commit URLs.

If publication fails before npm accepts the package, diagnose and rerun the same
protected tag. Once npm accepts a version, never overwrite, unpublish, or reuse
it; fix forward with the next beta version.
