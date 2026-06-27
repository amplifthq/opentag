# Publishing OpenTag to npm

OpenTag npm packages are published manually from a local checkout until a release pipeline exists.

## What gets published

Publish all public packages together with the same version. The CLI depends on local runtime and adapter packages, so publishing only `@opentag/cli` is not enough.

Current release version:

```text
0.2.0
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

Then publish each package from the repo root:

```bash
corepack pnpm --dir packages/core publish --access public
corepack pnpm --dir packages/client publish --access public
corepack pnpm --dir packages/telegram publish --access public
corepack pnpm --dir packages/runner publish --access public
corepack pnpm --dir packages/store publish --access public
corepack pnpm --dir packages/github publish --access public
corepack pnpm --dir packages/lark publish --access public
corepack pnpm --dir packages/slack publish --access public
corepack pnpm --dir packages/dispatcher publish --access public
corepack pnpm --dir packages/local-runtime publish --access public
corepack pnpm --dir packages/cli publish --access public
```

## User install check

After publishing, verify the global CLI path:

```bash
npm install -g @opentag/cli
opentag --help
opentag setup
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
