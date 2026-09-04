# @opentag/store

Durable SQLite state for the paired OpenTag Runner, plus the Control Plane's
provider-delivery journal.

## Install

```bash
pnpm add @opentag/store
```

## Paired Runner schema

- `migratePairedRunnerSchema` creates only the Run, Attempt, hosted-authority,
  lifecycle, readiness, source-lineage, and schema-ledger tables used by the
  paired Runner.
- Initialization is restart-safe. An unmarked existing database or a changed
  ready schema fails closed and is left untouched.
- This is a breaking fresh-database contract. Select a new state database and
  preserve any earlier SQLite file separately; OpenTag never drops or rewrites
  it automatically.
- `createPairedRunnerRepository` supplies the narrow repository methods consumed by
  the paired runtime.

## Example

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  createPairedRunnerRepository,
  migratePairedRunnerSchema,
} from "@opentag/store";

const sqlite = new Database("opentag.db");
migratePairedRunnerSchema(sqlite);

const repo = createPairedRunnerRepository(drizzle(sqlite));
```

## Stability

The paired schema is internal durability authority for the OpenTag Runner. It
is not an embedded dispatcher API and does not accept legacy local-runtime
databases.
