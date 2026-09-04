# Versioning and Release Policy

## Status

Current policy for the pre-1.0 OpenTag package family, 2026-09-04.

## Package discovery

The publishable package set is discovered dynamically from
`packages/*/package.json`. A package belongs to the release set only when its
manifest declares:

```json
{ "publishConfig": { "access": "public" } }
```

The release package-plan command is the authority for the exact set and
dependency-first order. Do not maintain a second hard-coded package or app
list in documentation, release scripts, or tests. Do not assume a fixed package
count; the set may change as packages are removed or added.

The plan must verify that every public package's runtime `@opentag/*`
dependency is also publishable, reject dependency cycles, and resolve a valid
topological build/publish order.

```bash
corepack pnpm release:publication-set
```

## Pre-1.0 versioning

Before `1.0.0`, all publishable packages move in lockstep on one coordinated
version. Public TypeScript, HTTP, protocol, storage, or package-layout changes
must be called out in release notes even though `0.x` SemVer permits breaking
changes within a minor release.

- Patch releases are for fixes that preserve the supported public contract.
- Minor releases may add capabilities or make a documented breaking change.
- Any release may remove an explicitly retired, unsupported surface when the
  removal is recorded in the release notes and the current docs no longer
  advertise it.

The root workspace and non-publishable applications remain private and are not
included merely because they are present under the repository tree.

Historical release-by-release detail belongs in the
[CHANGELOG](../CHANGELOG.md), not in this policy.

## Release authority and immutable artifacts

The release commit is the single source for every package artifact. Build the
coordinated package set from that commit and publish the exact resulting
artifacts. A later retry or promotion must not rebuild a package from a
different tree.

The required promotion sequence is:

```text
clean release commit
  -> dynamic package plan
  -> build / test / pack
  -> publish exact versions to npm `next`
  -> install and verify exact registry artifacts
  -> promote the same artifacts to `latest`
  -> create matching git tag and GitHub Release
```

`next` is a verification channel, not a second package family. Promotion only
changes dist-tags; it does not rebuild, repack, or republish artifacts.

## Verification gates

Before publication, run the repository's build, lint, typecheck, tests, package
plan, privacy checks, ACP/Slack protocol checks, and release check described in
the [npm release runbook](./npm-release.md).

The release check must pack the dynamically discovered set, install the exact
artifacts into a clean consumer, and verify the installed CLI/runtime contract.
The package plan, lockfile, artifact manifests, and installed dependency graph
must all agree with the release commit.

After publishing to `next`:

1. Read back each exact registry version and its package metadata.
2. Install those exact versions in a clean directory.
3. Run CLI help, setup, doctor, service, and the bounded supported runtime
   checks from the registry installation.
4. Verify the self-hosted Slack paired-relay path and one paired Runner where
   the release gate requires it.
5. Verify GitHub publication/readback evidence separately from local execution.
6. Promote to `latest` only after all required checks pass.

A passing local test or package install proves source/artifact behavior only.
It does not prove live Slack delivery, GitHub provider acceptance, deployment,
or completion of an external side effect.

## Outcome evidence

Release verification must preserve the distinction between:

- artifact built;
- artifact published to the registry;
- exact registry artifact installed;
- service/runtime check passed;
- provider request attempted;
- provider result observed;
- external action completed.

If a provider request may have happened but the result cannot be verified,
retain `outcome_unknown` and stop before retrying or promotion. Do not turn a
process exit, HTTP acceptance, queued intent, or stale readback into a release
success claim.

## Tag and GitHub Release

Create the matching annotated `v<version>` tag and GitHub Release from the same
commit whose artifacts were published to `next`. The tag must not silently
point at a later rebuild. GitHub publication/readback evidence is verified as a
provider boundary; it is not substituted by the npm or git tag operation.
