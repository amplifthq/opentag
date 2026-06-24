# @opentag/core

Core protocol types and validation for OpenTag.

Use this package when you need to create, validate, parse, or document OpenTag protocol objects without depending on any provider SDK or runtime service.

## Install

```bash
pnpm add @opentag/core
```

## Exports

- `OpenTagEventSchema`, `OpenTagRunSchema`, `OpenTagRunResultSchema`: Zod schemas for protocol objects.
- `OpenTagEvent`, `OpenTagRun`, `OpenTagRunResult`: TypeScript types inferred from the schemas.
- `parseOpenTagMention`: extracts an `@opentag` command from workspace text.
- `commandFromRawText`: maps raw command text to a normalized intent and V1 command parse.
- `OpenTagJsonSchemas`: JSON Schema definitions for systems that do not use TypeScript or Zod.

## Example

```ts
import { OpenTagEventSchema, parseOpenTagMention } from "@opentag/core";

const command = parseOpenTagMention("@opentag fix this flaky test");
if (!command.matched) {
  throw new Error("No OpenTag command found");
}

const event = OpenTagEventSchema.parse({
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: new Date().toISOString(),
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: command.rawText, intent: command.intent, args: command.args },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
});
```

## Command Parser V1

`parseOpenTagMention` keeps the simple launch syntax:

```text
@opentag fix this flaky test
```

It also accepts a lightweight V1 command DSL for protocol hints:

```text
@opentag review auth changes --file packages/auth/src/index.ts --range 12-30 --approval required --executor codex
```

The first word still maps to `fix`, `review`, `investigate`, `explain`, `run`, or `unknown`. Remaining free text becomes `command.args.prompt` and `command.parsed.prompt`. Supported flags include `--file`, `--path`, `--line`, `--range`, `--scope`, `--network restricted`, `--approval required|auto|never`, `--executor`, `--runner`, `--label`, `--timeout`, and `--url`.

The parser is intentionally additive. Existing consumers can keep using `command.rawText`, `command.intent`, and `command.args`; newer adapters can read `command.parsed` for references, requested scopes, approval hints, executor hints, network policy hints, and parser diagnostics.

## Stability

This package is the most stable OpenTag surface. Protocol changes should be additive whenever possible and follow the repository versioning policy.
