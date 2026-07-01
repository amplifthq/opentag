# Versioning and Publishing Policy

OpenTag packages are versioned and published as a coordinated package family.

## Package Family

Public packages:

- `@opentag/cli`
- `@opentag/local-runtime`
- `@opentag/core`
- `@opentag/client`
- `@opentag/dispatcher`
- `@opentag/github`
- `@opentag/lark`
- `@opentag/slack`
- `@opentag/telegram`
- `@opentag/runner`
- `@opentag/store`

Private runnable apps are not published:

- `@opentag/dispatcher-app`
- `@opentag/github-probot`
- `@opentag/slack-events`
- `@opentag/opentagd`

## Pre-1.0 Policy

The current public release is `0.3.5`. The public API is still settling, so all releases remain in the `0.x` line until the package contracts are stable enough for `1.0.0`.

The first npm release was published as the coordinated `0.1.0` package family.
The `0.2.0` release added the published CLI, local runtime package, and Lark and Telegram packages.
The `0.3.0` release improved CLI setup flexibility, source-thread approval rendering, Slack interactivity, and executor result summaries.
The `0.3.4` release improves service startup reliability, Lark status updates, final-card readability, and read-only executor result summaries.
The `0.3.5` release adds Linux user-service support and keeps unsupported platforms on terminal startup by default.

For each npm release:

- Set every public package to the same version.
- Keep `private: true` only on runnable apps and the root workspace.
- Verify `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Run `npm pack --dry-run --json` in every public package directory and inspect included files.

For `0.x` releases:

- Patch versions fix bugs without changing public TypeScript contracts or HTTP semantics.
- Minor versions may add optional fields, new functions, new adapters, or carefully documented breaking changes.
- Every breaking change must be called out in release notes because SemVer treats `0.x` as unstable but users still need migration guidance.

## 1.0 and Later

After `1.0.0`, follow SemVer:

- Patch: bug fixes and documentation updates that do not change public behavior.
- Minor: backward-compatible additions such as optional fields, new adapters, and new helper functions.
- Major: breaking changes to exported types, function signatures, endpoint semantics, storage requirements, or package layout.

## Compatibility Rules

- Prefer additive changes over modifying existing fields.
- Keep `@opentag/core` as the compatibility anchor for protocol objects.
- Avoid leaking app-only environment variable behavior into package APIs.
- Treat callback message shape, executor contracts, and dispatcher client method signatures as public API.
- If a storage change requires migration behavior, document it in release notes and keep `migrateSchema` idempotent.

## Release Checklist

1. Update package versions consistently across public packages.
2. Update changelog or release notes with package-specific changes.
3. Run `pnpm install` to refresh `pnpm-lock.yaml`.
4. Run `pnpm lint`.
5. Run `pnpm typecheck`.
6. Run `pnpm test`.
7. Run `pnpm build`.
8. Run `npm pack --dry-run --json` in each public package directory.
9. Publish public packages with `publishConfig.access=public`.
10. Create a matching GitHub Release, for example `v0.3.0`, pointing at the commit that produced the npm packages.
