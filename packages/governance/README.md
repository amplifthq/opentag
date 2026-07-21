# @opentag/governance

Deterministic completion governance for OpenTag work loops.

This package owns the Phase 1 completion predicate and its small command/query orchestration surface. It keeps executor success separate from evidence-backed work completion.

## Install

```bash
pnpm add @opentag/governance
```

## Responsibilities

- Evaluate finite completion gates against immutable artifacts, normalized evidence, material-action receipts, and bounded waivers.
- Bind delivery gates to one work cycle, change request, and resource version.
- Produce explainable `CompletionAssessment` snapshots with stable reason codes.
- Coordinate reassessment through injected repository, clock, and ID ports.
- Preserve legacy behavior through an explicit execution-compatibility contract whose assessments are not evidence-backed.

The package does not import provider SDKs, own SQLite, call executors, or render source-channel messages. Provider adapters normalize facts; the store enforces durability; the dispatcher composes those boundaries.
