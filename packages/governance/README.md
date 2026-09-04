# @opentag/governance

Deterministic proposal and publication evidence evaluation for OpenTag.

This package keeps executor success separate from evidence-backed proposal and
publication readiness.

Persistence, Attempt leasing, Runner selection, and operator presentation remain
outside this package.

## Install

```bash
pnpm add @opentag/governance
```

## Responsibilities

- Evaluate finite completion gates against immutable artifacts, normalized evidence, material-action receipts, and bounded waivers.
- Bind delivery gates to one work cycle, change request, and resource version.
- Produce explainable `CompletionAssessment` snapshots with stable reason codes.
- Coordinate reassessment through injected repository, clock, and ID ports.
- Keep proposal readiness and evidence-backed completion distinct from executor
  success.

The package does not import provider SDKs, own SQLite, select a Runner, call
executors, or render source-channel messages. The Control Plane composes those
boundaries.
