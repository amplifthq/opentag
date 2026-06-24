# @opentag/store

SQLite and Drizzle persistence primitives for OpenTag.

Use this package when embedding the dispatcher, testing dispatcher behavior, or building a compatible control plane that wants OpenTag's default run storage and lease model.

## Install

```bash
pnpm add @opentag/store
```

## Exports

- `migrateSchema`: creates or updates the SQLite schema.
- `createOpenTagRepository`: repository API for runners, bindings, runs, leases, progress, completion, and audit events.
- Drizzle table definitions from `schema.ts`.
- Types such as `ClaimedOpenTagRun`, `OpenTagAuditEvent`, `RepoBinding`, and `SlackChannelBinding`.

## Example

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";

const sqlite = new Database("opentag.db");
migrateSchema(sqlite);

const repo = createOpenTagRepository(drizzle(sqlite));

await repo.registerRunner({ runnerId: "runner_local", name: "Local Runner" });
await repo.createRepoBinding({
  provider: "github",
  owner: "acme",
  repo: "demo",
  runnerId: "runner_local"
});
```

## Reliability Notes

`createRun` uses a unique source event index plus `ON CONFLICT DO NOTHING` so webhook replays can return the original run instead of creating duplicate work. `claimNextRun` uses a conditional status update before returning a claimed run, which keeps concurrent runners from claiming the same queued row. Callback dead letters are stored as run audit events and can be listed through `listCallbackDeadLetters`.

## Stability

The repository methods are public API for embedded control planes. The raw Drizzle table definitions are lower-level and may evolve with migrations.
