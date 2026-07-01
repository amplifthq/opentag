# Publishing OpenTag to npm

OpenTag npm packages are published manually from a local checkout until a release pipeline exists.

## What gets published

Publish all public packages together with the same version. The CLI depends on local runtime and adapter packages, so publishing only one package is not enough.

Current release version:

```text
0.3.5
```

Package publish order:

1. `@opentag/core`
2. `@opentag/client`
3. `@opentag/telegram`
4. `@opentag/runner`
5. `@opentag/store`
6. `@opentag/github`
7. `@opentag/lark`
8. `@opentag/slack`
9. `@opentag/dispatcher`
10. `@opentag/local-runtime`
11. `@opentag/cli`

## Preflight

Use the repository package manager through Corepack:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm release:check
```

`release:check` builds the workspace, packs every publishable package, installs those tarballs into a clean npm project, and verifies that the installed `opentag` command runs.

## Publish

Log in to npm first:

```bash
npm whoami
```

Then publish from the repo root:

```bash
corepack pnpm release:publish
```

For a dry run:

```bash
corepack pnpm release:publish -- --dry-run
```

If npm asks for a two-factor one-time password, do not pass `--otp` by default for OpenTag releases.
Refresh the local npm browser login instead, then rerun the normal publish command:

```bash
npm login --auth-type=web
npm whoami
corepack pnpm release:publish
```

If npm still requires a per-publish one-time password after a fresh browser login, stop and publish from a trusted interactive terminal or adjust the npm account/session policy. Do not paste one-time passwords into shared logs or release automation.

## User install check

After publishing, verify the global CLI and no-install paths:

```bash
npm install -g @opentag/cli
opentag --help
opentag doctor
npx @opentag/cli --help
npx @opentag/cli doctor
```

The `@opentag/cli` package exposes this binary:

```json
{
  "bin": {
    "opentag": "./dist/index.js"
  }
}
```

That means a normal npm install creates an `opentag` command for the user.
