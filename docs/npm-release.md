# Publishing OpenTag to npm

## Status

Current release runbook for the pre-1.0 package family, 2026-09-04. The
runbook assumes a clean checkout and one exact release commit. It does not
hard-code a version, package count, or package list.

For policy and SemVer rules, see [Versioning and Release Policy](./versioning.md).
For historical release context, see the [CHANGELOG](../CHANGELOG.md).

## Release authority

The release commit is the authority for every published artifact. Before any
registry side effect:

- start from the intended exact commit;
- ensure the working tree is clean;
- record the commit SHA in the release record;
- derive the package plan from the manifests at that commit;
- do not continue if the checkout, lockfile, or package plan changes.

The release record must keep the exact commit SHA, package-plan output, gate
receipts, registry verification, provider evidence, and promotion result. Do
not put npm passwords, access tokens, OTPs, Slack credentials, GitHub tokens,
fencing tokens, or raw provider payloads in that record or in logs.

## Manifest-derived package plan

The publication set is discovered from `packages/*/package.json`. A package is
publishable only when its manifest has:

```json
{ "publishConfig": { "access": "public" } }
```

The package-plan script is the authority for the exact set and dependency-first
order. It verifies that public runtime dependencies are also publishable and
that the dependency graph is acyclic. Do not maintain a second list in this
runbook, a release script, or a test.

Run:

```bash
corepack pnpm release:publication-set
```

All publishable packages use one coordinated pre-1.0 version. Do not infer the
version or package count from this document; read both from the plan and the
manifests on the release commit.

## Required pre-publication gates

Run the repository scripts in the release order below. Each command must be
run against the same clean commit and its result retained as a receipt:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm release:publication-set
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke:privacy -- --allow-missing --report <release-report-path>
corepack pnpm verify:delivery-fixtures
corepack pnpm test:team-relay
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm e2e:control-plane
corepack pnpm smoke:acp-conformance
corepack pnpm smoke:openclaw-acp-conformance
corepack pnpm release:check
```

`test:team-relay` requires its explicitly configured test database. If a
provider, database, Docker, ACP, or audit dependency is unavailable, retain
the failure as a validation gap and stop; do not substitute a local-only pass
for the missing gate.

`release:check` packs the manifest-derived set, installs the packed artifacts
into a clean consumer, checks the installed CLI/runtime, verifies dependency
closure and production dependency safety, and exercises the installed package
surface. It is a packaging gate, not proof of provider-live behavior.

## Publish the `next` candidate

After all pre-publication gates pass, use the existing publisher so package
order, duplicate handling, clean-commit checks, and npm access checks stay in
one implementation:

```bash
corepack pnpm release:publish -- --tag next
```

The publisher derives the same package plan and publishes exact manifest
versions in dependency order. It must not be invoked with a dirty tree or a
different commit from the recorded release authority. Do not use a skip-check
option for a release.

Do not request or pass an npm OTP by default. If npm requires an interactive
step, stop the automated flow, refresh the legitimate npm login in an
interactive terminal, and rerun the normal publisher. Never put an OTP in a
shared prompt, script, log, artifact, or release receipt.

## Verify exact registry artifacts

`next` is a verification channel. After publication, the package plan must be
re-read and every package must be checked individually:

1. Registry metadata reports the exact manifest version.
2. The package exists at the `next` dist-tag with that same version.
3. Tarball integrity and npm metadata are available and consistent.
4. The exact registry artifacts install into a clean directory without
   workspace aliases.
5. The installed CLI reports the expected version and passes help, setup,
   doctor, service, and bounded runtime checks.
6. The installed dependency tree passes the release security checks.

Use the existing `release:check` and package-plan tooling for these checks;
do not copy a large shell loop into this document. A missing registry response,
integrity mismatch, partial publication, or installed CLI failure blocks
promotion.

## Provider-live evidence

When the release gate includes provider-live verification, retain sanitized
receipts for this exact path:

```text
Slack Source App
  -> self-hosted Control Plane
  -> one paired local Runner
  -> ACP Attempt
  -> optional governed GitHub publication
  -> exact-head GitHub readback
  -> truthful Slack evidence projection
```

The evidence must identify the release commit or immutable artifact, Run,
Attempt, lease/fence, target, action/operation identity, provider observation,
and final presentation without recording credentials or raw message content.

A local test, installed CLI, Runner heartbeat, queued intent, or process exit
does not prove Slack delivery, GitHub acceptance, exact-head state, or external
completion. If provider I/O may have happened but its result is not verifiable,
record `outcome_unknown` and reconcile the original operation before retrying.

## Promote to `latest`

Move `latest` only after the complete manifest-derived set has been published
to `next`, every exact registry artifact has been verified, the installed CLI
gate has passed, and all required Slack/Runner/GitHub evidence is complete.

Promotion is a dist-tag operation only:

- do not rebuild;
- do not repack;
- do not republish;
- do not promote a partial package set;
- do not replace missing provider evidence with local output.

If `next` verification fails, leave `latest` unchanged and preserve the failure
receipt. A retry must use the same release commit and must re-check the plan
before any new registry operation.

## Tag and GitHub Release

Create the matching annotated `v<version>` tag and GitHub Release from the same
exact commit whose artifacts were published and verified under `next`. The tag
and Release are release metadata, not substitutes for package integrity or
provider outcome evidence.

## Rollback

Rollback changes dist-tags only. Move every publishable package's `latest` tag
to the previous coordinated version after recording the rollback authority and
reason. Never overwrite or unpublish an immutable npm version, and never
rebuild an older version to repair a tag.

## Operational references

- [Versioning and Release Policy](./versioning.md) — current policy and SemVer.
- [Slack-to-GitHub Integration Verification](./real-integration-smoke-test.md) — provider evidence boundary.
- [CHANGELOG](../CHANGELOG.md) — historical release detail.
