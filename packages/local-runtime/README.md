# @opentag/local-runtime

Local paired Runner helpers used by `@opentag/cli`.

Use this package when embedding the same Control V1 Runner loop, local recovery
store, diagnostics, and GitHub publication helpers that the CLI uses.

## Install

```bash
pnpm add @opentag/local-runtime
```

## Exports

- `serveDaemon`: starts the paired Runner loop.
- `createDaemonRuntimeInput`: derives the Control V1 Runner input from config.
- `runDoctor`: checks relay reachability, Project Targets, checkouts, and executors.
- `parseDaemonConfig`: parses the local Runner configuration.

Subpath exports are also available:

```ts
import { serveDaemon } from "@opentag/local-runtime/daemon";
import { runDoctor } from "@opentag/local-runtime/doctor";
```

## Requirements

- Node.js 22.14 or newer.
- A writable, fresh local database path for Runner recovery and execution
  evidence. An unmarked earlier database is rejected and left unchanged.
- A local checkout for any Project Target you bind.
- One canonical `daemon.relayUrl`: an HTTPS origin whose exact origin is
  authorized by `daemon.trustedRelay` after pairing.

## Stability

This package is the paired Runner boundary for the CLI. Repositories,
credentials, worktrees, and coding-agent execution remain local.
