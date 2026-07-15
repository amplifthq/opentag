# Publishing OpenTag to npm

OpenTag npm packages are published manually from a clean local checkout until
a trusted release pipeline exists. All public packages ship as one coordinated
version.

## Current release

```text
0.6.0
```

The release is first published on the npm `next` dist-tag, tested from the
registry, then promoted to `latest`. The exact commit that produced the npm
artifacts must also receive the matching `v0.6.0` git tag and GitHub Release.

All 15 package names already have a `0.5.0` release. Publishing `0.6.0` with
`--tag next` must leave every `latest` pointer on `0.5.0` until the complete
registry, ACP, and live-platform gate passes.

## Public package discovery and order

The release helpers discover packages from `packages/*/package.json`. A package
is in the publication set only when its manifest contains:

```json
{
  "publishConfig": {
    "access": "public"
  }
}
```

The helpers validate that every `@opentag/*` runtime dependency of a public
package is also in that set, build the internal dependency graph, and publish
it in topological order. Do not add a second hand-maintained package list to a
release script or this guide.

Run `corepack pnpm release:publication-set` whenever the exact set or order is
needed. Its live, dependency-first output is the authoritative publication
plan.

## Release gate

Start from the intended release commit with a clean working tree. Confirm that
all 15 public manifests use `0.6.0` and that the frozen lockfile is current,
then run the verification ladder in this order:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm release:publication-set
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke:governance -- --all --report .omx/governance-matrix/all.json
corepack pnpm smoke:privacy -- --allow-missing --report .omx/governance-matrix/privacy.json
OPENTAG_BUILTIN_ACP_AGENTS=hermes OPENTAG_HERMES_PROFILE=<profile> corepack pnpm smoke:acp-conformance
OPENTAG_BUILTIN_ACP_AGENTS=openclaw OPENTAG_OPENCLAW_PROFILE=opentag-conformance corepack pnpm smoke:acp-conformance
corepack pnpm release:check
```

`release:check` repeats the build as a packaging precondition, packs every
automatically discovered public package, installs all tarballs into a clean npm
project, audits the installed production dependency tree at `high` severity,
and runs the installed CLI's help and doctor checks. It fails before publish
when the public-package set is inconsistent, the dependency graph is cyclic, a
tarball is missing, the clean install cannot resolve the complete package
family, the audit finds a high/critical vulnerability, or the installed CLI
checks fail. If the npm audit service is temporarily unavailable, retain the
error as release evidence and retry the gate; do not treat an unavailable audit
as a clean result.

The OpenClaw gate expects a running Gateway and the named profile. Override
`OPENTAG_OPENCLAW_COMMAND`, `OPENTAG_OPENCLAW_GATEWAY_URL`, or
`OPENTAG_OPENCLAW_EXPECTED_VERSION` when the conformance environment differs.
The capability-aware gate must pass its readiness, scratch, and worktree cases;
it records cancellation as skipped while the definition declares
`supportsCancel: false`.

Also run the strict capability audit and keep its output with the release
record:

```bash
OPENTAG_OPENCLAW_PROFILE=opentag-conformance corepack pnpm smoke:openclaw-acp-conformance
```

The strict audit is fail-closed. On stock OpenClaw 2026.7.1, the cwd/session
cases must pass but process-tree cancellation is expected to fail because a
cancelled tool may continue through its completion marker. Do not promote that
known non-zero result into release failure while `supportsCancel: false` is
truthful, and do not change the capability to `true` until the same strict
audit passes on the exact supported OpenClaw release.

Do not use `--skip-check` for a release. Keep the release-gate outputs with the
release record, but do not commit reports that contain local paths or live
provider identifiers.

## Publish the `next` canary

Confirm npm access immediately before publishing:

```bash
npm whoami
npm org ls opentag
corepack pnpm release:publish -- --tag next
```

The publish command uses the same automatic publication set and topological
order as `release:check`. A coordinated release is incomplete until all 15
packages exist at `0.6.0`; do not promote a partial package family.

If npm asks for a two-factor one-time password, do not pass `--otp` by default
for OpenTag releases. Refresh the local npm browser login, then rerun the normal
publish command:

```bash
npm login --auth-type=web
npm whoami
corepack pnpm release:publish -- --tag next
```

If npm still requires a per-publish code after a fresh browser login, stop and
continue from a trusted interactive terminal or adjust the npm account/session
policy. Never paste a one-time password into shared logs or automation.

## Verify from the npm registry

Do not smoke-test the workspace build for this gate. Install the exact canary
version into a new directory so npm must resolve every dependency from the
registry:

```bash
smoke_root="$(mktemp -d)"
npm install --prefix "$smoke_root" --no-audit --no-fund @opentag/cli@0.6.0
"$smoke_root/node_modules/.bin/opentag" --version
"$smoke_root/node_modules/.bin/opentag" --help
npm audit --prefix "$smoke_root" --omit=dev --audit-level=high
```

The version must be `0.6.0`. With isolated config and state directories, run
the setup, doctor, and foreground-start path for one platform that has real
test credentials:

```bash
export OPENTAG_CONFIG_HOME="$smoke_root/config"
export OPENTAG_STATE_DIR="$smoke_root/state"
export PATH="$smoke_root/node_modules/.bin:$PATH"

opentag setup
opentag doctor
opentag start
```

Use the relevant platform setup guide for the credentialed `opentag setup`
answers. While `opentag start` is running, send one real provider event and
verify the complete loop: provider ingest, Run creation, local execution,
source-thread reply, and the expected audit/action receipt. Stop the foreground
process after the receipt is visible. Record which platform was tested and the
redacted evidence in the release notes; never record provider tokens, fencing
tokens, raw ACP frames, or full private message IDs.

Also verify every package and its canary tag before promotion:

```bash
for manifest in packages/*/package.json; do
  [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
  package="$(jq -r '.name' "$manifest")"
  test "$(npm view "$package@0.6.0" version)" = "0.6.0"
  npm view "$package" dist-tags --json
done
```

## Promote the same artifacts to `latest`

Promotion changes dist-tags only; it must not rebuild or republish. After all
registry and live-platform checks pass, run the same command for every package.
It is intentionally idempotent for first-release packages whose `latest` tag
was created by npm:

```bash
for manifest in packages/*/package.json; do
  [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
  package="$(jq -r '.name' "$manifest")"
  npm dist-tag add "$package@0.6.0" latest
done
```

Rerun the package loop from the registry-verification section and confirm both
`next` and `latest` point at `0.6.0` for all 15 packages.

## Create the matching source release

Create the source tag from the exact clean commit used for `release:publish`.
Copy the `v0.6.0` section of `CHANGELOG.md` into a temporary release-notes file,
then run:

```bash
git tag -a v0.6.0 -m "OpenTag v0.6.0"
git push origin v0.6.0
gh release create v0.6.0 \
  --verify-tag \
  --title "OpenTag v0.6.0" \
  --notes-file /tmp/opentag-v0.6.0-release-notes.md
```

Verify that the GitHub Release tag resolves to the same commit that produced
the npm tarballs. The release is not complete until npm, git, and GitHub all
identify version `0.6.0`.

## Dist-tag rollback

Do not unpublish immutable package versions during rollback.

- If canary validation fails before promotion, leave the existing packages'
  previous `latest` tags untouched and stop the rollout. npm has already
  created `latest` for any first-release package and rejects removing that tag;
  if the new package is unsafe, deprecate the bad version and publish a fixed
  version rather than trying to erase immutable history. Preserve `next` for
  diagnosis or move it to the corrected version.
- If `latest` promotion fails partway, first finish or retry the idempotent
  promotion loop. If 0.6.0 itself must be withdrawn, restore `0.5.0` for the
  complete package family and leave 0.6.0 on `next` for diagnosis:

```bash
for manifest in packages/*/package.json; do
  [ "$(jq -r '.publishConfig.access // ""' "$manifest")" = "public" ] || continue
  package="$(jq -r '.name' "$manifest")"
  test "$(npm view "$package@0.5.0" version)" = "0.5.0"
  npm dist-tag add "$package@0.5.0" latest
  npm dist-tag add "$package@0.6.0" next
done
```

Verify all dist-tags after rollback and publish a clear incident note. A later
fix must use a new version; never overwrite `0.6.0`.
