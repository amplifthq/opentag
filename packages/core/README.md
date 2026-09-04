# @opentag/core

Provider-neutral validation primitives used inside the OpenTag Control Plane,
Slack adapter, and paired Runner.

## Install

```bash
pnpm add @opentag/core
```

## Current boundary

- `OpenTagEventSchema` validates the normalized event handed from the Slack
  Source App boundary to the paired execution path.
- `OpenTagRunSchema` and `OpenTagRunResultSchema` validate local execution facts.
- completion and evidence schemas keep executor outcome separate from accepted
  publication evidence.
- `commandFromRawText` parses the text that remains after the verified Slack
  mention is removed.
- `OpenTagJsonSchemas` exposes the same validation shapes to non-TypeScript
  consumers.

This package does not accept provider webhooks, choose a Runner, publish to
GitHub, or own delivery. Those authorities remain in the Control Plane,
Project Target, and provider-specific packages.

```ts
import { commandFromRawText } from "@opentag/core";

const command = commandFromRawText("investigate the failing check");
```

## Stability

OpenTag is pre-1.0. Schemas may change when the supported Slack → paired Runner
→ GitHub path becomes smaller or more precise; unsupported compatibility
surfaces are removed instead of kept as aliases.
