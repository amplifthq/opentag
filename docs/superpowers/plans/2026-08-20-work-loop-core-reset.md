# OpenTag Work-Loop Core Reset Implementation Plan

> **Status: Superseded.** Do not execute this destructive reset. It is replaced
> by [2026-08-28-self-hosted-team-relay.md](./2026-08-28-self-hosted-team-relay.md),
> which preserves the source-thread product, existing Control Plane, paired
> local Runner, ACP execution, delivery kernel, and evidence governance.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current multi-channel end-to-end Agent application with a small, embeddable protocol and deep Work Loop Module that owns admission, attempts, approval, cancellation, evidence, completion, and durable effect identity.

**Architecture:** OpenTag becomes a provider-neutral work-loop kernel. `@opentag/protocol` defines the wire vocabulary; `@opentag/work-loop` owns all lifecycle transitions behind four operations; `@opentag/sqlite` implements persistence; `@opentag/acp` executes claimed effects through ACP; `@opentag/cli` is only a reference host. Slack, GitHub, hosted ingress, Control Plane, provider delivery, installation management, and multi-tenant routing are removed from the product core and from this repository's vNext runtime.

**Tech Stack:** TypeScript, Zod, Vitest, SQLite with `better-sqlite3`, Agent Client Protocol via `@agentclientprotocol/sdk`, pnpm workspaces, tsup.

## Global Constraints

- This is an intentional breaking reset. Do not preserve package names, exports, database migrations, configuration files, CLI commands, environment variables, HTTP routes, provider payloads, or runtime state from OpenTag 0.11.
- Keep the runtime floor at Node.js `>=22.14.0`, the workspace manager at `pnpm@9.15.0`, Zod at `^4.4.3`, `better-sqlite3` at `^13.0.2`, and `@agentclientprotocol/sdk` at `^1.2.1`; do not add a new runtime dependency without revising this plan.
- Do not add compatibility shims, deprecated aliases, dual-read logic, dual-write logic, legacy import subpaths, legacy database importers, or forwarding packages.
- Do not implement Slack, GitHub, GitLab, Linear, Lark, Discord, Teams, Telegram, hosted ingress, a web console, a multi-tenant Control Plane, provider delivery retries, provider installation management, or provider-facing receipts in vNext.
- Treat existing source/provider implementations as design evidence only. The new protocol must not contain provider names, provider event types, channel IDs, thread IDs, message timestamps, installation IDs, or webhook delivery semantics.
- A source integration translates its input into a `WorkCommand` outside the Work Loop Module. The kernel does not acknowledge source transports and does not claim that a source user saw a reply.
- Evidence is a work-loop fact, not the product definition. `reported` and `unverifiable` evidence must never satisfy a gate requiring `verified` evidence.
- One canonical Work Loop Implementation owns admission, command idempotency, state transitions, effect creation, leases, fencing, cancellation, approval, evidence ingestion, completion, and terminal immutability.
- Executors never write Work state directly. They claim an Effect and settle it through the Work Loop Interface.
- Repositories never implement lifecycle policy. They provide atomic persistence and compare-and-swap primitives to the Work Loop Implementation.
- No source file in the four library packages may import Hono, React, a provider SDK, `pg`, or another application package.
- `@opentag/protocol` may depend only on Zod. `@opentag/work-loop` may depend only on `@opentag/protocol` and Zod. `@opentag/sqlite` may depend only on `@opentag/protocol`, `@opentag/work-loop`, `better-sqlite3`, and SQLite/Drizzle helpers. `@opentag/acp` may depend only on `@opentag/protocol`, `@opentag/work-loop`, `@agentclientprotocol/sdk`, and process/git helpers.
- Use explicit named exports. Do not use `export *` in any vNext public entry point.
- The top-level public export budgets are: at most 30 named exports from `@opentag/protocol`, 12 from `@opentag/work-loop`, 6 from `@opentag/sqlite`, and 10 from `@opentag/acp`.
- Every command has a caller-supplied `commandId`. Replaying the same `commandId` with the same canonical digest returns the original receipt; replaying it with a different digest returns `conflict` and changes no state.
- Every Effect has a stable `effectId`. Every claim returns a new opaque `leaseId` and monotonically increasing integer `fence`. Only the current lease and fence may settle the Effect.
- `outcome_unknown` is terminal for an Effect until a human supplies new evidence or a new explicit command. It is never retried automatically.
- Terminal Work states are immutable. A late Executor result, expired lease, duplicate command, or stale fence cannot reopen or alter a terminal Work.
- Timestamps, IDs, and repositories are injected in tests. Do not use sleeps, wall-clock races, random IDs, network calls, provider credentials, or a running PostgreSQL server in kernel tests.
- Use the existing code only when it makes the new Module deeper. Delete copied lifecycle paths as soon as the new path replaces them.
- After destructive cutover, the repository must contain one lifecycle state machine, one effect-claim owner, one completion evaluator, and one CLI host.
- Publishing, npm deprecation, migration notices, and changes to external deployments require a separate release authorization. This plan ends with locally verified packages and release artifacts.

---

## Product Decision

The vNext product statement is:

> **OpenTag is an open protocol and embeddable engine for governed coding-agent work loops.**

The primary user is a library or runtime author embedding a coding Agent into a product, CLI, IDE, queue worker, or internal tool. The primary job is to turn a work request into a durable sequence of admitted work, fenced execution, optional approval, evidence-backed completion, cancellation, and truthful terminal state.

The following are explicitly not the vNext product:

- a Slack-to-Agent bridge;
- a GitHub bot;
- a hosted inbox for offline local Agents;
- a multi-channel notification gateway;
- a SaaS Control Plane;
- an Agent observability dashboard;
- a general workflow engine;
- a receipt proxy between coding Agents and SaaS products.

## Target Repository Shape

```text
packages/
  protocol/               # Stable wire schemas and canonical serialization
  work-loop/              # Deep Module: lifecycle, policy, effects, evidence
  sqlite/                 # SQLite Repository Adapter
  acp/                    # ACP Executor Adapter and worker loop
  cli/                    # Thin reference host and executable
examples/
  basic-work-loop/        # No credentials; in-memory Repository and fake worker
  acp-local/              # Real local ACP Agent example
docs/
  architecture/
    work-loop.md          # Target architecture and invariants
  protocol.md             # Public command/effect/evidence reference
  embedding.md            # Library integration guide
  cli.md                  # Reference host guide
scripts/
  architecture/
    check-kernel-boundaries.mjs
    public-export-budgets.json
    forbidden-paths.json
  test/
    kernel-pack-smoke.mjs
```

The final dependency graph is acyclic:

```text
@opentag/protocol
       ▲       ▲
       │       │
@opentag/work-loop
       ▲       ▲
       │       │
@opentag/sqlite   @opentag/acp
       ▲             ▲
       └──────┬──────┘
              │
       @opentag/cli
```

No library package depends on `@opentag/cli`. No library package imports from `apps/`, `examples/`, or another package's `src/` directory.

## Public Interface

### Protocol vocabulary

`@opentag/protocol` defines the Zod schemas and inferred types for these exact concepts:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActorRef = {
  id: string;
  kind: "human" | "agent" | "system";
};

export type WorkspaceRef =
  | { kind: "local"; path: string }
  | { kind: "scratch" };

export type EvidenceFact = {
  id: string;
  kind: string;
  assurance: "verified" | "reported" | "unverifiable";
  subject: { type: string; ref: string; version?: string };
  claim: {
    predicate: string;
    outcome: string;
    observations?: Record<string, string>;
  };
  provenance: {
    producer: string;
    producerVersion: string;
    payloadDigest: string;
  };
  observedAt: string;
};

export type CompletionGate =
  | { id: string; kind: "executor_succeeded" }
  | {
      id: string;
      kind: "evidence";
      evidenceKind: string;
      minimumAssurance: "verified" | "reported";
    };

export type CompletionContract = {
  gates: CompletionGate[];
};

export type SubmitWorkCommand = {
  type: "submit_work";
  commandId: string;
  submittedAt: string;
  actor: ActorRef;
  request: {
    objective: string;
    context?: JsonValue;
    workspace: WorkspaceRef;
    executor?: string;
    completion: CompletionContract;
    approval: "never" | "before_apply";
  };
};

export type ApproveProposalCommand = {
  type: "approve_proposal";
  commandId: string;
  workId: string;
  proposalId: string;
  decision: "approve" | "reject";
  actor: ActorRef;
  decidedAt: string;
};

export type CancelWorkCommand = {
  type: "cancel_work";
  commandId: string;
  workId: string;
  actor: ActorRef;
  reason: string;
  cancelledAt: string;
};

export type ChangeProposal = {
  id: string;
  artifactRef: string;
  artifactDigest: string;
  summary: string;
  baseRevision?: string;
};

export type RecordEvidenceCommand = {
  type: "record_evidence";
  commandId: string;
  workId: string;
  evidence: EvidenceFact;
  recordedAt: string;
};

export type ResolveEffectCommand = {
  type: "resolve_effect";
  commandId: string;
  workId: string;
  effectId: string;
  resolution:
    | { status: "succeeded"; evidence: EvidenceFact[] }
    | { status: "failed"; reason: string };
  actor: ActorRef;
  resolvedAt: string;
};

export type WorkCommand =
  | SubmitWorkCommand
  | ApproveProposalCommand
  | CancelWorkCommand
  | RecordEvidenceCommand
  | ResolveEffectCommand;

export type WorkStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "applying"
  | "verifying"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type EffectOutcome =
  | {
      status: "succeeded";
      output: JsonValue;
      proposal?: ChangeProposal;
      evidence?: EvidenceFact[];
    }
  | { status: "failed"; error: { code: string; message: string } }
  | { status: "cancelled"; reason: string }
  | { status: "outcome_unknown"; reason: string };

export type WorkEffect =
  | {
      kind: "execute_agent";
      objective: string;
      context?: JsonValue;
      workspace: WorkspaceRef;
      executor?: string;
    }
  | {
      kind: "apply_proposal";
      proposalId: string;
      workspace: Extract<WorkspaceRef, { kind: "local" }>;
      artifactRef: string;
      artifactDigest: string;
    };

export type ClaimEffectInput = {
  workerId: string;
  kinds: Array<WorkEffect["kind"]>;
  leaseExpiresAt: string;
};

export type ClaimedEffect = {
  effectId: string;
  workId: string;
  leaseId: string;
  fence: number;
  leaseExpiresAt: string;
  effect: WorkEffect;
};

export type SettleEffectInput = {
  settlementId: string;
  workerId: string;
  effectId: string;
  workId: string;
  leaseId: string;
  fence: number;
  settledAt: string;
  outcome: EffectOutcome;
};

export type WorkView = {
  id: string;
  version: number;
  status: WorkStatus;
  objective: string;
  workspace: WorkspaceRef;
  activeEffect?: {
    effectId: string;
    kind: WorkEffect["kind"];
    fence: number;
  };
  proposal?: ChangeProposal;
  completion: {
    satisfied: boolean;
    gates: Array<{
      id: string;
      satisfied: boolean;
      reason: string;
    }>;
  };
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommandReceipt = {
  outcome: "recorded" | "duplicate" | "conflict" | "rejected";
  commandId: string;
  workId?: string;
  view?: WorkView;
  reason?: { code: string; message: string };
};
```

The top-level Protocol Interface exports only these types: `JsonValue`, `WorkCommand`, `WorkView`, `ClaimEffectInput`, `ClaimedEffect`, `SettleEffectInput`, `CommandReceipt`, `WorkEffect`, `EffectOutcome`, `EvidenceFact`, `CompletionContract`, and `ChangeProposal`. It exports only these runtime values: `WorkCommandSchema`, `EvidenceFactSchema`, `CompletionContractSchema`, `WorkViewSchema`, `ClaimEffectInputSchema`, `ClaimedEffectSchema`, `SettleEffectInputSchema`, `canonicalJson`, and `canonicalDigest`. Supporting shapes such as `ActorRef`, individual command variants, and `WorkspaceRef` remain structurally available through the exported unions but are not separate top-level exports. The package does not export mention parsing, presentation models, provider payloads, configuration, database records, HTTP request types, or Control Plane messages.

### Work Loop Interface

`@opentag/work-loop` exports one factory and the ports required to embed it:

```ts
export type WorkLoopDependencies = {
  repository: WorkLoopRepository;
  admission: AdmissionPolicy;
  clock: { now(): string };
  ids: {
    next(prefix: "work" | "event" | "effect" | "lease" | "proposal"): string;
  };
};

export interface AdmissionPolicy {
  readonly id: string;
  readonly version: string;
  evaluate(input: {
    actor: ActorRef;
    request: SubmitWorkCommand["request"];
  }):
    | { decision: "admit" }
    | { decision: "reject"; code: string; message: string };
}

export interface WorkLoop {
  dispatch(command: WorkCommand): Promise<CommandReceipt>;
  query(input: { type: "get_work"; workId: string }): Promise<WorkView | null>;
  claim(input: ClaimEffectInput): Promise<ClaimedEffect | null>;
  settle(input: SettleEffectInput): Promise<CommandReceipt>;
}

export function createWorkLoop(dependencies: WorkLoopDependencies): WorkLoop;
```

The four operations are the complete public lifecycle Interface. Admission, state transitions, attempts, effect creation, leases, fencing, proposals, evidence evaluation, and terminal settlement remain inside the Implementation.

### Effect model

The Work Loop emits exactly two effect kinds:

```ts
type ExecuteAgentEffect = Extract<WorkEffect, { kind: "execute_agent" }>;
type ApplyProposalEffect = Extract<WorkEffect, { kind: "apply_proposal" }>;
```

When approval is `before_apply`, a proposal moves Work to `awaiting_approval`. Approval creates one `apply_proposal` Effect. Rejection terminally fails the Work with reason `proposal_rejected`. When approval is `never`, an `execute_agent` success does not create an apply Effect; completion is evaluated directly from the result and evidence. `resolve_effect` is the only way to move an `outcome_unknown` Effect after a human has inspected its real-world outcome.

### State invariants

The Work Loop Implementation enforces these invariants in code and tests:

1. One admitted `submit_work` command creates one Work and one `execute_agent` Effect; one rejected command creates no Work or Effect and returns a durable rejected receipt.
2. Duplicate command, evidence, proposal, and Effect settlement inputs are idempotent by stable identity and canonical digest.
3. One pending Effect can have at most one current lease and fence.
4. A stale or mismatched lease cannot settle, cancel, append evidence to, or otherwise mutate Work.
5. Cancellation stops unclaimed Effects and invalidates current leases; late settlement cannot reopen the Work.
6. Approval cannot refer to a proposal from another Work or an older proposal generation.
7. `apply_proposal` cannot be created without an approved proposal and a local workspace.
8. `outcome_unknown` blocks Work and never implies failure, success, or permission to retry.
9. `completed` requires every Completion Gate to pass.
10. A `verified` gate cannot be satisfied by `reported` or `unverifiable` evidence.
11. Every state change and Effect transition appends a durable event in the same transaction.
12. A terminal Work is immutable except that exact duplicate commands return their stored receipts.

---

## Task 1: Establish the vNext Protocol Package

**Files:**

- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/tsup.config.ts`
- Create: `packages/protocol/src/json.ts`
- Create: `packages/protocol/src/identity.ts`
- Create: `packages/protocol/src/evidence.ts`
- Create: `packages/protocol/src/completion.ts`
- Create: `packages/protocol/src/work.ts`
- Create: `packages/protocol/src/effects.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/canonical-json.test.ts`
- Create: `packages/protocol/test/work-command.test.ts`
- Create: `packages/protocol/test/evidence.test.ts`
- Create: `packages/protocol/test/effects.test.ts`
- Create: `packages/protocol/test/fixtures/protocol-v1.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Zod and Node's built-in Web Crypto or `node:crypto` digest support.
- Produces: The exact Protocol vocabulary and schemas defined above, `canonicalJson(value)`, and `canonicalDigest(value)`.

- [ ] **Step 1: Add failing schema tests for the public commands.**

  Cover valid submit, approve, cancel, and evidence commands; reject empty IDs, invalid RFC 3339 timestamps, blank objectives, unknown fields, non-absolute local paths, evidence without provenance, and an empty completion gate list.

- [ ] **Step 2: Run the Protocol tests and confirm they fail because the package does not exist.**

  ```bash
  corepack pnpm vitest run packages/protocol/test
  ```

  Expected result: FAIL resolving `packages/protocol/src/index.ts` or the new package.

- [ ] **Step 3: Implement canonical JSON and digest helpers.**

  Sort object keys recursively, preserve array order, reject `undefined`, functions, symbols, non-finite numbers, and cyclic objects, encode as UTF-8 JSON, and return a lowercase SHA-256 hex digest.

- [ ] **Step 4: Implement the schemas in focused files with explicit exports.**

  Use `.strict()` for every public object schema. Infer TypeScript types from Zod schemas; do not maintain parallel handwritten shapes.

- [ ] **Step 5: Freeze one golden protocol fixture.**

  `protocol-v1.json` contains one submit command, one evidence fact at each assurance level, one claimed Effect, one settlement, one Work view, and their expected canonical digests. Tests parse and re-serialize every object byte-for-byte.

- [ ] **Step 6: Build and test the package independently.**

  ```bash
  corepack pnpm --filter @opentag/protocol build
  corepack pnpm vitest run packages/protocol/test
  ```

  Expected result: PASS without first building any other workspace package.

- [ ] **Step 7: Commit the standalone protocol.**

  ```bash
  git add packages/protocol pnpm-lock.yaml
  git commit -m "feat: define the OpenTag work-loop protocol"
  ```

## Task 2: Build the Deep Work Loop Module with an In-Memory Repository

**Files:**

- Create: `packages/work-loop/package.json`
- Create: `packages/work-loop/tsconfig.json`
- Create: `packages/work-loop/tsup.config.ts`
- Create: `packages/work-loop/src/ports.ts`
- Create: `packages/work-loop/src/repository.ts`
- Create: `packages/work-loop/src/model.ts`
- Create: `packages/work-loop/src/commands.ts`
- Create: `packages/work-loop/src/effects.ts`
- Create: `packages/work-loop/src/state-machine.ts`
- Create: `packages/work-loop/src/work-loop.ts`
- Create: `packages/work-loop/src/index.ts`
- Create: `packages/work-loop/testing/in-memory-repository.ts`
- Create: `packages/work-loop/testing/deterministic-dependencies.ts`
- Create: `packages/work-loop/testing/index.ts`
- Create: `packages/work-loop/test/submit.test.ts`
- Create: `packages/work-loop/test/admission.test.ts`
- Create: `packages/work-loop/test/idempotency.test.ts`
- Create: `packages/work-loop/test/effect-lease.test.ts`
- Create: `packages/work-loop/test/cancellation.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `WorkCommand`, effect schemas, canonical digests, and views from `@opentag/protocol`.
- Produces: `createWorkLoop`, `WorkLoop`, `WorkLoopRepository`, `WorkLoopTransaction`, `WorkLoopDependencies`, and a testing-only in-memory Repository Adapter.

The Repository port is:

```ts
export interface WorkLoopRepository {
  transaction<T>(operation: (tx: WorkLoopTransaction) => Promise<T>): Promise<T>;
}

export interface WorkLoopTransaction {
  findCommand(commandId: string): Promise<StoredCommandReceipt | null>;
  insertCommand(command: StoredCommandReceipt): Promise<void>;
  loadWork(workId: string): Promise<StoredWork | null>;
  insertWork(work: StoredWork): Promise<void>;
  replaceWork(work: StoredWork, expectedVersion: number): Promise<void>;
  loadEffect(effectId: string): Promise<StoredEffect | null>;
  insertEffect(effect: StoredEffect): Promise<void>;
  replaceEffect(effect: StoredEffect, expectedFence: number): Promise<void>;
  claimNextEffect(input: {
    workerId: string;
    kinds: Array<"execute_agent" | "apply_proposal">;
    leaseId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<StoredEffect | null>;
  appendEvents(events: StoredWorkEvent[]): Promise<void>;
}
```

`StoredCommandReceipt`, `StoredWork`, `StoredEffect`, and `StoredWorkEvent` are JSON-safe storage records defined in `packages/work-loop/src/model.ts` and exported only from `@opentag/work-loop/repository`. `StoredWork.snapshot`, `StoredEffect.payload`, Effect outcomes, and event payloads are `JsonValue`; the Repository Adapter persists them opaquely and never interprets lifecycle policy. `claimNextEffect` performs only pending/expired selection, lease assignment, and fence increment. The Work Loop updates the owning Work and appends the claim event inside the same Repository transaction.

- [ ] **Step 1: Write a failing submit test through the four-operation Interface.**

  Submit one command, assert one queued Work and one pending `execute_agent` Effect, claim it, and assert Work becomes `running` with fence `1`.

- [ ] **Step 2: Write failing admission tests.**

  Inject one admitting policy and one rejecting policy. Assert the admitted request stores the policy ID/version snapshot and creates one Work/Effect. Assert rejection stores one rejected command receipt, creates no Work/Effect, and exact replay returns the same rejection.

- [ ] **Step 3: Write failing idempotency and conflict tests.**

  Assert same command ID plus same digest returns `duplicate` with the original receipt. Assert same command ID plus changed objective returns `conflict`, leaves the Work version unchanged, and creates no second Effect.

- [ ] **Step 4: Write failing lease and cancellation tests.**

  Claim with worker A, advance the injected clock past expiry, reclaim with worker B, reject worker A's settlement, accept worker B's settlement, and prove cancellation before and after claim invalidates settlement without reopening terminal state.

- [ ] **Step 5: Run the targeted tests and confirm RED.**

  ```bash
  corepack pnpm vitest run packages/work-loop/test/submit.test.ts packages/work-loop/test/admission.test.ts packages/work-loop/test/idempotency.test.ts packages/work-loop/test/effect-lease.test.ts packages/work-loop/test/cancellation.test.ts
  ```

- [ ] **Step 6: Implement the internal state machine and transactional command handler.**

  `state-machine.ts` is pure: `(state, input) => { state, events, effects }`. `work-loop.ts` owns repository transactions, digest comparison, receipt persistence, effect claim, settlement, and conversion to public views. No other file mutates lifecycle state.

- [ ] **Step 7: Implement the in-memory Repository Adapter as a semantic test double.**

  It must enforce optimistic Work versions, unique command IDs, unique Effect IDs, monotonic fences, terminal immutability, and transaction rollback by cloning state before each transaction.

- [ ] **Step 8: Run package tests and build.**

  ```bash
  corepack pnpm vitest run packages/work-loop/test
  corepack pnpm --filter @opentag/work-loop build
  ```

  Expected result: PASS without SQLite, ACP, provider credentials, network access, or a daemon.

- [ ] **Step 9: Commit the executable kernel.**

  ```bash
  git add packages/work-loop pnpm-lock.yaml
  git commit -m "feat: add the governed work-loop engine"
  ```

## Task 3: Move Approval, Evidence, and Completion into the Work Loop

**Files:**

- Create: `packages/work-loop/src/proposals.ts`
- Create: `packages/work-loop/src/completion.ts`
- Create: `packages/work-loop/src/evidence.ts`
- Modify: `packages/work-loop/src/model.ts`
- Modify: `packages/work-loop/src/commands.ts`
- Modify: `packages/work-loop/src/state-machine.ts`
- Modify: `packages/work-loop/src/work-loop.ts`
- Modify: `packages/work-loop/src/index.ts`
- Create: `packages/work-loop/test/approval.test.ts`
- Create: `packages/work-loop/test/evidence.test.ts`
- Create: `packages/work-loop/test/completion.test.ts`
- Create: `packages/work-loop/test/outcome-unknown.test.ts`

**Interfaces:**

- Consumes: successful `execute_agent` outcomes, `ChangeProposal`, `EvidenceFact`, approval commands, and Completion Contracts from `@opentag/protocol`.
- Produces: truthful `WorkView` projections and internal completion assessments. No new top-level public operation is added.

- [ ] **Step 1: Port the assurance ordering into a focused failing test.**

  Use the strict order `unverifiable < reported < verified`. A gate requiring `reported` accepts `reported` or `verified`; a gate requiring `verified` accepts only `verified`.

- [ ] **Step 2: Write failing proposal and approval tests.**

  Cover proposal produced with `before_apply`, approve once, duplicate approval, rejection, wrong Work ID, stale proposal ID, approval after cancellation, and approval after terminal completion.

- [ ] **Step 3: Write failing completion tests.**

  Cover executor-only completion, evidence-gated completion, multiple gates, evidence received before Executor settlement, duplicate evidence by same ID and digest, evidence ID conflict, and evidence after terminal state.

- [ ] **Step 4: Write failing `outcome_unknown` tests.**

  An unknown execution or apply outcome moves Work to `blocked`, persists the Effect outcome, emits one human-action event, and creates no replacement Effect. Duplicate unknown settlement returns the original receipt. A `resolve_effect` command with human-supplied verified evidence may resolve it to succeeded; a failed resolution terminally fails Work; conflicting resolution replay changes nothing.

- [ ] **Step 5: Run the focused tests and confirm RED.**

  ```bash
  corepack pnpm vitest run packages/work-loop/test/approval.test.ts packages/work-loop/test/evidence.test.ts packages/work-loop/test/completion.test.ts packages/work-loop/test/outcome-unknown.test.ts
  ```

- [ ] **Step 6: Port only the useful pure logic from the existing governance package.**

  Preserve assurance comparison, deterministic gate ordering, evidence subject matching, and completion explanations from `packages/governance/src/evaluate.ts`. Do not port workstreams, factory routing, provider presentation, source-thread continuation, or callback delivery behavior.

- [ ] **Step 7: Keep completion evaluation internal.**

  The public query returns the Work view with gate results and reasons. Do not export a second governance service, a completion repository, or a parallel command bus.

- [ ] **Step 8: Run all Protocol and Work Loop tests.**

  ```bash
  corepack pnpm vitest run packages/protocol/test packages/work-loop/test
  corepack pnpm --filter @opentag/protocol build
  corepack pnpm --filter @opentag/work-loop build
  ```

- [ ] **Step 9: Commit the governed lifecycle.**

  ```bash
  git add packages/work-loop
  git commit -m "feat: govern approval evidence and completion in one loop"
  ```

## Task 4: Implement the SQLite Repository Adapter from a Fresh Schema

**Files:**

- Create: `packages/sqlite/package.json`
- Create: `packages/sqlite/tsconfig.json`
- Create: `packages/sqlite/tsup.config.ts`
- Create: `packages/sqlite/src/schema.ts`
- Create: `packages/sqlite/src/repository.ts`
- Create: `packages/sqlite/src/open.ts`
- Create: `packages/sqlite/src/index.ts`
- Create: `packages/sqlite/test/repository-contract.test.ts`
- Create: `packages/sqlite/test/restart.test.ts`
- Create: `packages/sqlite/test/concurrency.test.ts`
- Create: `packages/sqlite/test/crash-boundaries.test.ts`
- Modify: `pnpm-lock.yaml`
- Create: `packages/work-loop/testing/repository-contract.ts`

**Interfaces:**

- Consumes: `WorkLoopRepository`, stored record types, and the shared Repository contract suite from `@opentag/work-loop/testing`.
- Produces: `openSqliteRepository({ filename }): WorkLoopRepository` and `closeSqliteRepository(repository): void`.

Use exactly five tables:

```text
works             id PK, version, status, snapshot_json, created_at, updated_at
commands          command_id PK, payload_digest, work_id, receipt_json, created_at
work_events       work_id, sequence, event_id UNIQUE, type, payload_json, occurred_at
effects           effect_id PK, work_id, kind, state, payload_digest, payload_json,
                  lease_id, fence, lease_expires_at, outcome_json, created_at, updated_at
evidence          evidence_id PK, work_id, payload_digest, payload_json, assurance, recorded_at
```

Required constraints are unique `(work_id, sequence)`, non-negative `works.version`, non-negative `effects.fence`, terminal Effect states requiring `outcome_json`, and claimed Effects requiring `lease_id` plus `lease_expires_at`.

- [ ] **Step 1: Extract one Repository contract suite from the in-memory tests.**

  The suite accepts a factory returning a fresh Repository and runs command idempotency, optimistic Work update, event ordering, atomic Effect enqueue, claim exclusivity, reclaim fencing, settlement idempotency, and rollback cases.

- [ ] **Step 2: Run the contract suite against a missing SQLite Adapter and confirm RED.**

  ```bash
  corepack pnpm vitest run packages/sqlite/test/repository-contract.test.ts
  ```

- [ ] **Step 3: Implement the fresh schema and atomic transactions.**

  Use `BEGIN IMMEDIATE` for claim and write transactions. Select one pending or expired Effect, increment its fence, assign the supplied lease ID, and return the claimed payload within the same transaction.

- [ ] **Step 4: Add restart tests.**

  Create Work, close the database, reopen it, replay the submit command, claim and settle the Effect, close and reopen again, and assert the same terminal Work view and one command/effect/event sequence.

- [ ] **Step 5: Add deterministic concurrent claim tests.**

  Open two SQLite connections to the same temporary file, issue two claims concurrently, and assert exactly one claim result. Expire its injected lease and assert the next claim has fence `2` while fence `1` cannot settle.

- [ ] **Step 6: Add crash-boundary tests.**

  Inject failures after command insert, Work insert, Effect insert, event append, claim update, and Effect settlement update. Every failed transaction must roll back fully; retrying the same command produces one durable result.

- [ ] **Step 7: Run the Adapter tests and build.**

  ```bash
  corepack pnpm vitest run packages/sqlite/test
  corepack pnpm --filter @opentag/sqlite build
  ```

- [ ] **Step 8: Commit the Repository Adapter.**

  ```bash
  git add packages/sqlite pnpm-lock.yaml
  git commit -m "feat: persist work loops in a fresh sqlite store"
  ```

## Task 5: Adapt the Existing ACP Work into a Small Executor Module

**Files:**

- Create: `packages/acp/package.json`
- Create: `packages/acp/tsconfig.json`
- Create: `packages/acp/tsup.config.ts`
- Create: `packages/acp/src/executor.ts`
- Create: `packages/acp/src/acp-executor.ts`
- Create: `packages/acp/src/builtin-agents.ts`
- Create: `packages/acp/src/worker.ts`
- Create: `packages/acp/src/workspace.ts`
- Create: `packages/acp/src/security.ts`
- Create: `packages/acp/src/index.ts`
- Create: `packages/acp/test/acp-executor.test.ts`
- Create: `packages/acp/test/worker.test.ts`
- Create: `packages/acp/test/cancellation.test.ts`
- Create: `packages/acp/test/security.test.ts`
- Create: `packages/acp/testing/deterministic-executor.ts`
- Create: `packages/acp/testing/executor-contract.ts`
- Create: `packages/acp/testing/index.ts`
- Copy and then simplify: `packages/runner/test/fixtures/acp-agent.mjs` to `packages/acp/test/fixtures/acp-agent.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Work Loop claim/settle operations and the existing ACP subprocess implementation.
- Produces: `ExecutorAdapter`, `createAcpExecutor`, `createBuiltinExecutorCatalog`, and `createWorkLoopWorker`.

The Executor Interface is:

```ts
export interface ExecutorAdapter {
  readonly id: string;
  canRun(effect: ClaimedEffect): Promise<{ ready: boolean; reason?: string }>;
  run(effect: ClaimedEffect, signal: AbortSignal): Promise<EffectOutcome>;
}

export interface WorkLoopWorker {
  runOnce(): Promise<"idle" | "settled">;
  runUntilIdle(input?: { maxEffects?: number }): Promise<number>;
  stop(): Promise<void>;
}
```

- [ ] **Step 1: Port the ACP fixture and write failing Adapter contract tests.**

  Cover text/tool events, successful result, refusal, malformed child output, process exit, cancellation, absolute local workspace, scratch workspace, and credential redaction.

- [ ] **Step 2: Write failing worker tests against the in-memory Work Loop.**

  Submit Work, run one worker, assert one claim and one settlement, duplicate `runOnce` returns `idle`, cancellation aborts the current ACP session, and stale settlement after lease expiry is rejected.

- [ ] **Step 3: Run the ACP tests and confirm RED.**

  ```bash
  corepack pnpm vitest run packages/acp/test
  ```

- [ ] **Step 4: Port the useful ACP Implementation.**

  Reuse subprocess lifecycle, ACP initialization, session creation, streaming normalization, cancellation, built-in agent discovery, environment scrubbing, and workspace isolation from `packages/runner/src`. Do not port OpenTag 0.11 Run types, dispatcher HTTP calls, provider progress formatting, factory roles, callback receipts, or control-plane readiness.

- [ ] **Step 5: Implement the worker as a thin Effect host.**

  `runOnce` claims one `execute_agent` or `apply_proposal` Effect, selects an Executor by explicit ID or catalog default, passes an AbortSignal, and settles once. If the subprocess exits after a material action may have started but before an outcome is known, settle `outcome_unknown`.

- [ ] **Step 6: Prove two Executor Adapters satisfy one contract.**

  Run the shared Adapter suite against `createAcpExecutor` and a deterministic test Executor. The test Executor lives under `packages/acp/testing` and is not exported from the main package path.

- [ ] **Step 7: Build and test Protocol, Work Loop, SQLite, and ACP in dependency order.**

  ```bash
  corepack pnpm --filter @opentag/protocol build
  corepack pnpm --filter @opentag/work-loop build
  corepack pnpm --filter @opentag/sqlite build
  corepack pnpm --filter @opentag/acp build
  corepack pnpm vitest run packages/protocol/test packages/work-loop/test packages/sqlite/test packages/acp/test
  ```

- [ ] **Step 8: Commit the ACP Adapter.**

  ```bash
  git add packages/acp pnpm-lock.yaml
  git commit -m "feat: execute work-loop effects through ACP"
  ```

## Task 6: Replace the CLI with a Thin Reference Host

**Files:**

- Replace: `packages/cli/package.json`
- Replace: `packages/cli/src/index.ts`
- Create: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/commands/run.ts`
- Create: `packages/cli/src/commands/show.ts`
- Create: `packages/cli/src/commands/approve.ts`
- Create: `packages/cli/src/commands/cancel.ts`
- Create: `packages/cli/src/commands/worker.ts`
- Create: `packages/cli/src/output.ts`
- Create: `packages/cli/test/run.test.ts`
- Create: `packages/cli/test/approval.test.ts`
- Create: `packages/cli/test/restart.test.ts`
- Delete: every other file under `packages/cli/src/`
- Delete: existing `packages/cli/test/` files not listed above
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `@opentag/protocol`, `@opentag/work-loop`, `@opentag/sqlite`, and `@opentag/acp` only.
- Produces: the `opentag` executable and no reusable application framework.

The CLI surface is exactly:

```text
opentag run <objective> [--cwd PATH] [--executor ID] [--json]
opentag show <work-id> [--json]
opentag approve <work-id> <proposal-id> [--reject] [--json]
opentag cancel <work-id> --reason TEXT [--json]
opentag worker [--once] [--executor ID]
```

State defaults to `.opentag/opentag.db` inside the selected local workspace. Scratch work uses the platform temporary directory and records no secret or absolute temporary path in evidence output.

- [ ] **Step 1: Replace CLI tests with failing vNext behavior tests.**

  Test `run` with a deterministic Executor, JSON output, human output, approval pause, approve-and-apply, cancellation, process restart, missing Executor, invalid local path, and non-zero exit for failed or blocked Work.

- [ ] **Step 2: Run the new CLI tests and confirm RED.**

  ```bash
  corepack pnpm vitest run packages/cli/test
  ```

- [ ] **Step 3: Delete setup, pairing, platform catalogs, provider registration, service installation, health, relay, and daemon command code.**

  The replacement CLI does not read OpenTag 0.11 configuration and does not offer migration. A user supplies a new command and workspace explicitly.

- [ ] **Step 4: Implement the runtime composition root.**

  `runtime.ts` opens SQLite, creates the Work Loop, loads the ACP catalog, creates one worker, and closes all resources. No lifecycle policy may live in a command handler.

- [ ] **Step 5: Implement the exact command surface.**

  Commands translate arguments into Protocol commands, call the Work Loop Interface, and render returned views. `run` calls `runUntilIdle`; if approval is required, it exits successfully with `awaiting_approval` and prints the exact approve command.

- [ ] **Step 6: Run CLI tests and build.**

  ```bash
  corepack pnpm vitest run packages/cli/test
  corepack pnpm --filter @opentag/cli build
  ```

- [ ] **Step 7: Commit the reference host.**

  ```bash
  git add packages/cli pnpm-lock.yaml
  git commit -m "feat: replace the gateway cli with a work-loop host"
  ```

## Task 7: Perform the Destructive Cutover and Delete the End-to-End Product

**Files:**

- Delete: `apps/control-plane/`
- Delete: `apps/dispatcher/`
- Delete: `apps/github-probot/`
- Delete: `apps/lark-events/`
- Delete: `apps/opentagd/`
- Delete: `apps/slack-events/`
- Delete: `apps/telegram-events/`
- Delete: `packages/client/`
- Delete: `packages/control-protocol/`
- Delete: `packages/core/`
- Delete: `packages/delivery-contract/`
- Delete: `packages/discord/`
- Delete: `packages/dispatcher/`
- Delete: `packages/github/`
- Delete: `packages/gitlab/`
- Delete: `packages/governance/`
- Delete: `packages/lark/`
- Delete: `packages/linear/`
- Delete: `packages/local-runtime/`
- Delete: `packages/runner/`
- Delete: `packages/slack/`
- Delete: `packages/store/`
- Delete: `packages/teams/`
- Delete: `packages/telegram/`
- Delete: `examples/custom-runner/`
- Delete: `examples/embedded-dispatcher/`
- Delete: `examples/github-to-echo/`
- Delete: `examples/github-to-pr/`
- Delete: `examples/openclaw-acp/`
- Delete: `scripts/dev/`
- Delete: `scripts/release/`
- Delete: `scripts/test/`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: The independently green Protocol, Work Loop, SQLite, ACP, and CLI packages from Tasks 1–6.
- Produces: A repository in which the target architecture is the only executable product architecture.

- [ ] **Step 1: Capture the last useful legacy test-to-invariant mapping.**

  Before deletion, record in the commit message which new tests replace legacy coverage for idempotency, admission, leases, stale fences, cancellation, approval, evidence assurance, completion, ACP cancellation, and restart. Do not copy provider-specific assertions into the kernel.

- [ ] **Step 2: Delete the listed applications, packages, and examples in one commit-sized cutover.**

  Use explicit paths. Do not leave archived source directories, legacy packages outside the workspace, or build exclusions that hide retained code.

- [ ] **Step 3: Remove obsolete root scripts and dependencies.**

  Delete all existing `scripts/dev`, `scripts/release`, and `scripts/test` files. Remove Control Plane, provider, delivery-fixture, protocol-runtime, Slack-runtime, browser E2E, factory conformance, service installation, relay, release-publication, and live-provider commands from `package.json`. Keep only `build`, `test`, `typecheck`, and `lint`; Task 8 adds the new kernel-specific gates.

- [ ] **Step 4: Reduce CI to the surviving repository before adding fitness gates.**

  Remove PostgreSQL services, browser installation, provider secrets, provider smoke commands, and deleted package steps from `.github/workflows/ci.yml`. The temporary cutover CI runs frozen install, build, typecheck, lint, and test.

- [ ] **Step 5: Regenerate the workspace lockfile.**

  ```bash
  corepack pnpm install --lockfile-only
  ```

- [ ] **Step 6: Prove there are no legacy imports or package names.**

  ```bash
  rg -n '@opentag/(client|control-protocol|core|delivery-contract|dispatcher|governance|local-runtime|runner|store|slack|github|gitlab|linear|lark|discord|teams|telegram)' packages examples package.json pnpm-lock.yaml
  ```

  Expected result: no matches. The command may report that `apps/` no longer exists.

- [ ] **Step 7: Run the complete surviving repository verification.**

  ```bash
  corepack pnpm build
  corepack pnpm typecheck
  corepack pnpm lint
  corepack pnpm test
  ```

  Expected result: all commands PASS with no PostgreSQL server, provider credentials, daemon, browser, or network service.

- [ ] **Step 8: Commit the destructive cutover.**

  ```bash
  git add -A apps packages examples scripts package.json pnpm-workspace.yaml tsconfig.json vitest.config.ts pnpm-lock.yaml .github/workflows/ci.yml
  git commit -m "refactor!: remove the end-to-end gateway architecture"
  ```

## Task 8: Add Architecture Fitness Gates and Standalone Package Proof

**Files:**

- Create: `scripts/architecture/check-kernel-boundaries.mjs`
- Create: `scripts/architecture/public-export-budgets.json`
- Create: `scripts/architecture/forbidden-paths.json`
- Create: `scripts/test/kernel-pack-smoke.mjs`
- Create: `packages/work-loop/test/architecture.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: final package manifests, source imports, public entry points, and packed tarballs.
- Produces: deterministic `check:architecture`, `test:kernel`, and `test:pack` gates.

- [ ] **Step 1: Write a failing dependency-direction check.**

  Parse every surviving `package.json` and every static import. Reject undeclared dependencies, imports into another package's `src/`, reverse dependencies, provider/HTTP/UI/database imports in Protocol or Work Loop, and any package directory outside the target set.

- [ ] **Step 2: Write a failing public-export budget check.**

  Parse each public `src/index.ts`, reject wildcard exports, count named exports against the Global Constraints, and print the unexpected symbol names when a budget is exceeded.

- [ ] **Step 3: Write a forbidden-path check.**

  `forbidden-paths.json` contains the deleted application and package paths from Task 7 plus provider-specific documentation directories. The gate fails if any path returns.

- [ ] **Step 4: Add semantic ownership checks.**

  Reject lifecycle status mutation outside `packages/work-loop/src/state-machine.ts`, effect claim SQL outside `packages/sqlite/src/repository.ts`, and direct Work table access from CLI or ACP. Use a reviewable list of allowed files rather than heuristics that silently ignore matches.

- [ ] **Step 5: Implement the pack smoke.**

  Pack Protocol, Work Loop, SQLite, and ACP into a fresh temporary directory, install only the tarballs and their registry dependencies, compile a consumer using `createWorkLoop`, submit and complete one Work, close and reopen SQLite, and assert the terminal view survives restart.

- [ ] **Step 6: Wire deterministic CI gates.**

  CI runs, in order: frozen install, architecture check, build, typecheck, lint, unit/integration tests, and pack smoke. It does not start PostgreSQL, browsers, provider sandboxes, or cloud services.

- [ ] **Step 7: Run all gates locally.**

  ```bash
  corepack pnpm check:architecture
  corepack pnpm test:kernel
  corepack pnpm test:pack
  corepack pnpm build
  corepack pnpm typecheck
  corepack pnpm lint
  corepack pnpm test
  ```

- [ ] **Step 8: Commit the anti-decay gates.**

  ```bash
  git add scripts package.json .github/workflows/ci.yml packages/work-loop/test/architecture.test.ts
  git commit -m "test: enforce the work-loop architecture"
  ```

## Task 9: Add Two Minimal Examples That Prove the Real Seams

**Files:**

- Create: `examples/basic-work-loop/package.json`
- Create: `examples/basic-work-loop/src/index.ts`
- Create: `examples/basic-work-loop/README.md`
- Create: `examples/acp-local/package.json`
- Create: `examples/acp-local/src/index.ts`
- Create: `examples/acp-local/README.md`
- Create: `examples/test/examples.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: public package entry points only.
- Produces: one credential-free in-memory example and one real local ACP example.

- [ ] **Step 1: Write a failing example smoke test.**

  Spawn each example as a separate Node process. `basic-work-loop` must end in `completed` with verified fixture evidence. `acp-local` uses the ACP fixture in CI and accepts a real Executor ID when run manually.

- [ ] **Step 2: Implement the credential-free example in no more than 60 source lines.**

  It imports the in-memory Repository Adapter from `@opentag/work-loop/testing`, submits one Work, claims and settles its Effect using a small test Executor, queries the result, and prints the completion reasons.

- [ ] **Step 3: Implement the ACP example in no more than 100 source lines.**

  It opens SQLite, creates the Work Loop and ACP worker, submits a local-workspace request, runs until idle or approval, and prints the exact next command. It contains no provider, webhook, HTTP server, or daemon setup.

- [ ] **Step 4: Prove two Repository Adapters and two Executor Adapters.**

  Run the shared Repository suite against in-memory and SQLite. Run the shared Executor suite against deterministic and ACP implementations. Treat failure of either pair as evidence that the corresponding Seam is not real.

- [ ] **Step 5: Run examples and package verification.**

  ```bash
  corepack pnpm vitest run examples/test/examples.test.ts
  corepack pnpm test:pack
  ```

- [ ] **Step 6: Commit the examples.**

  ```bash
  git add examples pnpm-lock.yaml
  git commit -m "docs: prove the work-loop seams with minimal examples"
  ```

## Task 10: Replace Product Documentation and Supersede the Old Architecture

**Files:**

- Replace: `README.md`
- Replace: `CONTEXT.md`
- Create: `docs/architecture/work-loop.md`
- Create: `docs/protocol.md`
- Create: `docs/embedding.md`
- Create: `docs/cli.md`
- Create: `docs/adr/0005-work-loop-core-reset.md`
- Mark superseded or delete: `docs/design.md`
- Mark superseded: `docs/adr/0001-accepted-progress-attribution.md`
- Mark superseded: `docs/adr/0002-durable-reassessment-obligations.md`
- Mark superseded: `docs/adr/0003-node-postgresql-control-plane.md`
- Mark superseded if present: `docs/adr/0004-always-on-channel-ingress-local-execution.md`
- Delete: `docs/platforms/`
- Delete: `docs/control-plane-clean-room-ledger.md`
- Delete: `docs/control-plane-deployment.md`
- Delete: `docs/control-plane-runtime-architecture.md`
- Delete: `docs/software-factory-control-plane.md`
- Delete: `docs/relay-security-hardening.md`
- Delete: `docs/source-thread-action-receipts.md`
- Delete or rewrite: remaining documents whose subject is a deleted application, provider, relay, factory, hosted ingress, or 0.11 package Interface

**Interfaces:**

- Consumes: only behavior and commands proven by Tasks 1–9.
- Produces: one coherent public story, architecture reference, protocol reference, embedding guide, CLI guide, and superseding ADR.

- [ ] **Step 1: Rewrite the README around a library-first Quick Start.**

  The first screen contains the product statement, a package install command, and a complete embedded example under 30 lines. Provider credentials, background services, setup wizards, supported-channel tables, Control Plane claims, and offline mention claims do not appear.

- [ ] **Step 2: Document ownership and non-goals.**

  `docs/architecture/work-loop.md` names the Work Loop as the sole owner of lifecycle transitions, SQLite as persistence only, ACP as effect execution only, and CLI as composition only. It includes the dependency graph and all twelve state invariants from this plan.

- [ ] **Step 3: Document the Protocol from generated schemas.**

  `docs/protocol.md` shows one example for each command, Effect, settlement outcome, Evidence assurance, and Work state. Every example is loaded and parsed by a documentation test so docs cannot drift from schemas.

- [ ] **Step 4: Write the superseding ADR.**

  ADR 0005 records that OpenTag deliberately abandoned multi-channel product ownership, Hosted Control Plane, transport receipts, and compatibility with 0.11. It explains why work-loop governance remains and why future provider integrations must live outside the kernel.

- [ ] **Step 5: Remove obsolete documentation.**

  Delete every document that teaches a deleted command, package, environment variable, provider, app, hosted route, or deployment. Preserve historical ADR text only when its status is visibly `Superseded by ADR 0005` at the top.

- [ ] **Step 6: Add documentation link and schema checks.**

  Validate internal Markdown links, execute code examples, and parse every JSON example against the exported Zod schema.

- [ ] **Step 7: Run final documentation and repository verification.**

  ```bash
  corepack pnpm check:architecture
  corepack pnpm test:kernel
  corepack pnpm test:pack
  corepack pnpm build
  corepack pnpm typecheck
  corepack pnpm lint
  corepack pnpm test
  ```

- [ ] **Step 8: Commit the product reset documentation.**

  ```bash
  git add README.md CONTEXT.md docs
  git commit -m "docs!: redefine OpenTag as a governed work-loop engine"
  ```

## Task 11: Produce the Local Release Candidate Evidence Bundle

**Files:**

- Create: `artifacts/work-loop-reset/manifest.json`
- Create: `artifacts/work-loop-reset/verification.md`
- Create: `artifacts/work-loop-reset/package-digests.json`
- Modify: none outside the generated evidence directory

**Interfaces:**

- Consumes: the exact Git SHA, package tarballs, CI commands, example outputs, architecture check, and pack smoke.
- Produces: a local release-candidate evidence bundle. It does not publish, push, deploy, deprecate packages, or contact a provider.

- [ ] **Step 1: Start from a clean checkout of the exact candidate SHA.**

  Record the SHA, Node version, pnpm version, operating system, and lockfile digest in `manifest.json`.

- [ ] **Step 2: Install and run the complete gate from the clean checkout.**

  ```bash
  corepack pnpm install --frozen-lockfile
  corepack pnpm check:architecture
  corepack pnpm build
  corepack pnpm typecheck
  corepack pnpm lint
  corepack pnpm test
  corepack pnpm test:pack
  ```

- [ ] **Step 3: Pack the public packages and record SHA-256 digests.**

  Record the filenames and digests for Protocol, Work Loop, SQLite, ACP, and CLI tarballs. Do not call `npm publish`.

- [ ] **Step 4: Run the two examples from packed tarballs.**

  Save redacted stdout, exit status, resulting Work IDs, command digests, Effect IDs, fences, and terminal completion reasons in `verification.md`.

- [ ] **Step 5: Confirm the destructive reset conditions.**

  Record that all forbidden legacy paths are absent, no provider or Control Plane dependencies remain, no public wildcard exports remain, the four-operation Work Loop Interface is unchanged, and all terminal claims came from local deterministic evidence.

- [ ] **Step 6: Commit only deterministic evidence.**

  ```bash
  git add artifacts/work-loop-reset
  git commit -m "chore: record the work-loop reset release evidence"
  ```

---

## Merge Gate

This branch is ready to merge only when all of the following are true:

- The repository contains only `protocol`, `work-loop`, `sqlite`, `acp`, and `cli` packages plus the two minimal examples.
- The legacy application, provider, Control Plane, dispatcher, local-runtime, broad core, governance, delivery, client, runner, and store paths are deleted.
- No compatibility package, import alias, legacy database reader, provider abstraction, hosted ingress stub, or dead build exclusion remains.
- The Work Loop top-level Interface has exactly `dispatch`, `query`, `claim`, and `settle`.
- The Protocol, Work Loop, SQLite, and ACP packages build and test independently in dependency order.
- In-memory and SQLite Repository Adapters pass the same contract suite.
- Deterministic and ACP Executor Adapters pass the same contract suite.
- The pack smoke succeeds in a clean temporary consumer with no workspace source resolution.
- A clean checkout passes architecture, build, typecheck, lint, tests, examples, and pack smoke without PostgreSQL, provider credentials, browsers, daemons, or cloud services.
- README Quick Start reaches a completed Work without configuring a SaaS channel.
- All documentation describes the vNext kernel; historical ADRs are visibly superseded and cannot be mistaken for active implementation plans.
- The release evidence bundle is tied to the exact candidate SHA and contains no claim of npm publication, deployment, provider acceptance, or production behavior.

## Stop Conditions

Stop and redesign the active task rather than adding another layer when any of these occurs:

- A new public operation is proposed instead of expressing behavior through the four existing operations.
- A provider concept enters Protocol or Work Loop.
- Lifecycle state is mutated outside the Work Loop state machine.
- An Executor or CLI writes repository records directly.
- A second idempotency, approval, cancellation, completion, or Effect retry system appears.
- A compatibility request would retain a deleted 0.11 package or schema.
- A test requires a sleep, provider credential, PostgreSQL server, or hosted deployment to prove kernel correctness.
- An error path would label `reported`, `unverifiable`, timed-out, or unknown behavior as verified success.

When a stop condition is hit, the correct response is deletion, a narrower Interface, or a revised invariant—not another facade or compatibility Adapter.
