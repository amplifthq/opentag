# OpenTag Self-Hosted Team Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first exact OpenTag team profile in which a Slack engineering-thread request is durably received by a user-operated always-on relay, executed by one paired local ACP Runner against a bound GitHub repository, and returned to the same Slack thread with truthful status, evidence, proposal-only completion, and optional exact-approved draft-PR Publication.

**Architecture:** Keep the existing Node/PostgreSQL Control Plane as the one team-mode ingress, Admission, queue, claim, cancellation, terminal, and delivery authority. Keep code, worktrees, Git credentials, coding-agent credentials, and ACP execution on the paired local Runner, which connects outbound through Control V1. Refactor existing Slack/GitHub/provider code behind a typed five-port Source App contract and reuse the existing delivery side-effect kernel, governance evaluator, material-action receipts, and local execution implementation instead of creating a second Work Loop.

**Tech Stack:** TypeScript, Node.js `>=22.14.0`, pnpm `9.15.0`, Zod `^4.4.3`, Hono, PostgreSQL 17, Drizzle, Vitest, SQLite for `local_direct`, `@agentclientprotocol/sdk`, Docker Compose.

## Global Constraints

- Preserve unrelated dirty-worktree changes. Never reset, blanket-stage, overwrite, or delete user WIP.
- Commit steps are local implementation checkpoints only. Before every commit, run `git diff --cached --name-status` and `git diff --cached --check`, and unstage any path not declared by that task. Push, PR, publish, deploy, and real-provider actions remain separately unauthorized.
- This plan supersedes `2026-08-20-work-loop-core-reset.md`; do not execute its package/application deletion tasks.
- Retain `apps/control-plane`, Control V1, `packages/local-runtime`, `packages/runner`, `packages/dispatcher/src/delivery`, `packages/delivery-contract`, `packages/governance`, `packages/slack`, `packages/github`, and the relevant SQLite store contracts.
- `local_direct` remains a trial/single-machine mode and must display `offline_safe=false`.
- The certified team profile uses a self-hosted relay outside the paired Runner's availability fault domain. A same-machine background service remains `local_direct`.
- `managed_relay`, hosted coding execution, multi-Runner fallback, multi-region/HA claims, and provider-wide availability claims are outside this plan.
- Slack is the only certified Source App ingress. GitHub is a repository and opt-in Publication target, not a second certified ingress.
- One paired local Runner and one configured ACP Harness are the only eligible execution target in the certified profile.
- Source App integrations use typed Code Adapters only. Configuration contains installation data, Secret References, enabled capabilities, and bindings, not mapping DSLs or executable transforms.
- Source App packages never own ingress reservation, Admission, Run/Attempt lifecycle, claim/lease/fencing, cancellation, approval policy, completion, retry authority, delivery journaling, or terminal settlement.
- Provider acknowledgement occurs only after an Ingress Reservation, immutable payload digest/reference, and Ingress Processing Obligation commit atomically.
- Runner-offline waiting is durable but finite. Queue claim deadlines are Admission-frozen, non-renewable, and terminal on expiry.
- Automatic retry is allowed only when durable evidence proves that no material action could have started. Ambiguous external effects become `outcome_unknown` and are never replayed blindly.
- A stale Attempt never resumes or settles. Its workspace is preserved as interrupted evidence and is never automatically adopted, reset, cleaned, stashed, or deleted.
- Provider delivery outcome is independent from Run outcome. Ambiguous writes reconcile before retry; stale intermediate presentations coalesce into current truth.
- Slack membership grants participation only. Cancellation, binding changes, and material approvals require explicit requester/operator/approver capabilities.
- V1 is explicit-mention only. No ambient monitoring, proactive participation, scheduled work, standing instructions, or cross-thread/channel memory.
- Source Context contains the trigger plus at most 20 preceding same-thread messages and at most 64 KiB decoded text. Attachment-body custody is disabled.
- Readable relay content is retained while nonterminal and at most seven days after terminal settlement; content-free replay tombstones may remain 90 days.
- Default Publication Policy is `proposal_only`. Draft PR is opt-in through a pre-authorized binding and exact approval. V1 never auto-merges.
- PostgreSQL is the team relay's sole durable source of truth. Do not add Redis, a message broker, S3, or another database to the certified profile.
- Publishing, pushing, deploying a managed service, real provider canaries, or production activation require separate authorization. This plan ends with locally verified software, self-host packaging, and a canary runbook.
- Every completion claim must distinguish source facts, deterministic test evidence, exact-deployment evidence, real-provider evidence, and unverified gaps.

## Retained, Replaced, and Deferred Surfaces

### Retain and evolve

- `apps/control-plane/src/modules/{identity,runners,hosted-runs,jobs,audit}`
- `packages/control-protocol` and `packages/client`
- `packages/local-runtime` Control V1 pairing, readiness, pull/claim, lifecycle projection, and local state
- `packages/runner` ACP execution, worktree isolation, environment scrubbing, cancellation, and permission interception
- `packages/dispatcher/src/delivery/*` and `packages/delivery-contract`
- `packages/store/src/delivery-*` as the `local_direct` implementation and repository-contract evidence
- `packages/governance` pure completion evaluation
- `packages/core` channel, identity, permission, presentation, artifact, and evidence vocabulary
- `packages/slack` transport, verification, normalization, context, rendering, and Web API behavior
- `packages/github` source-control observation, Publication, and completion evidence
- `deploy/compose` and current Control Plane deployment checks

### Replace only after the certified path is green

- Provider-specific copies of bind/unbind/status/stop/cancel/approve command handling
- Team-mode Slack submission directly into the local SQLite dispatcher
- Slack-only delivery composition that bypasses a generic Source App registry
- Automatic execution-tail `commit/push/create PR` behavior
- Any compatibility default that equates Executor success with Work completion

### Defer

- `managed_relay`, multi-region, managed KMS, break-glass operations, and managed-service SLOs
- GitHub/Lark/Teams/Telegram/Discord/Linear/GitLab ingress certification
- Declarative Adapter manifests, mapping DSLs, dynamic plugin loading, and a marketplace ABI
- Ambient memory, proactive participation, schedules, standing work, and attachment-body custody
- Multi-Runner placement/fallback, remote hosted execution, auto-merge, and arbitrary SaaS connectors
- Large console redesigns and deletion of non-certified provider packages

---

## Task 1: Freeze Retained Authority Seams and Define the Typed Source App Contract

**Files:**

- Create: `packages/core/src/source-app.ts`
- Modify: `packages/core/src/channel-protocol.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/source-app.test.ts`
- Create: `packages/delivery-contract/src/observation.ts`
- Modify: `packages/delivery-contract/src/index.ts`
- Create: `packages/delivery-contract/test/observation.test.ts`
- Create: `packages/source-app-runtime/package.json`
- Create: `packages/source-app-runtime/tsconfig.json`
- Create: `packages/source-app-runtime/tsup.config.ts`
- Create: `packages/source-app-runtime/src/definition.ts`
- Create: `packages/source-app-runtime/src/registry.ts`
- Create: `packages/source-app-runtime/src/commands.ts`
- Create: `packages/source-app-runtime/src/index.ts`
- Create: `packages/source-app-runtime/test/registry.test.ts`
- Create: `packages/source-app-runtime/test/commands.test.ts`
- Create as compatibility re-export: `packages/dispatcher/src/source-app-registry.ts`
- Create as compatibility re-export: `packages/dispatcher/src/source-app-commands.ts`
- Modify: `packages/dispatcher/src/source-thread-control.ts`
- Modify: `packages/dispatcher/src/index.ts`
- Modify: `packages/dispatcher/package.json`
- Modify: `packages/dispatcher/tsconfig.json`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `OpenTagChannelInboundMessage`, `OpenTagChannelPresentationCommand`, `OpenTagReplyTargetRef`, and `OpenTagPresentation` from `@opentag/core`.
- Produces: dependency-light `@opentag/source-app-runtime`, one composite five-port `SourceAppDefinition`, `SourceAppCapabilities`, `SourceAppRegistry`, `SourceThreadCommand`, `SourceThreadCommandResult`, and one provider-neutral command service with injected authority ports. The runtime depends only on `@opentag/core` and `@opentag/delivery-contract`; both `@opentag/dispatcher` and the Control Plane consume it without depending on one another.

The contract must be structurally equivalent to:

```ts
export type SourceAppCapabilities = {
  threads: boolean;
  messageUpdate: boolean;
  reactions: boolean;
  interactiveActions: boolean;
  attachments: "metadata" | "body" | "unsupported";
  authenticatedDeletion: boolean;
  stableSourceVersions: boolean;
};

export type SourceAppCorePorts<RawDelivery, NativePresentation> = {
  appId: string;
  protocol: string;
  capabilities: SourceAppCapabilities;
  ingress: {
    verify(input: { rawBody: Uint8Array; headers: Headers; receivedAt: string }): Promise<unknown>;
    normalize(input: unknown): OpenTagChannelInboundMessage | null;
  };
  context: {
    readThread(input: {
      replyTarget: OpenTagReplyTargetRef;
      maxMessages: 20;
      maxDecodedBytes: 65536;
    }): Promise<{ messages: unknown[]; truncated: boolean; decodedBytes: number }>;
  };
  presentation: {
    render(command: OpenTagChannelPresentationCommand): NativePresentation;
  };
};

export type SourceAppDefinition<RawDelivery, NativePresentation, NativeRequest> =
  SourceAppCorePorts<RawDelivery, NativePresentation> & {
    installation: {
      appInstanceId: string;
      bindingDigest: string;
      credentialGeneration: number;
      credentialGenerationDigest: string;
    };
    delivery: {
      prepare(command: OpenTagChannelPresentationCommand): NativeRequest;
      deliver(input: {
        request: NativeRequest;
        intent: DeliveryIntentV2;
        signal?: AbortSignal;
      }): Promise<ProviderDeliveryResult>;
      reconcile(input: {
        intent: DeliveryIntentV2;
        request: NativeRequest;
      }): Promise<ProviderDeliveryResult>;
    };
  };
```

`SourceAppCorePorts` remains in `@opentag/core`; the composite type lives in `@opentag/source-app-runtime`, which may import `DeliveryIntentV2` and `ProviderDeliveryResult` from `@opentag/delivery-contract`. Do not make `@opentag/core` depend on the delivery contract. One registry entry atomically binds inbound and outbound ports to the same App instance, binding digest, credential generation, and capabilities; there is no second independently keyed delivery registration.

- [ ] **Step 1: Add failing contract tests for capabilities, strict validation, and registry identity**

```ts
it("registers one exact Source App and rejects a duplicate id", () => {
  const registry = new SourceAppRegistry();
  registry.register(fakeSourceApp({ appId: "slack" }));
  expect(() => registry.register(fakeSourceApp({ appId: "slack" })))
    .toThrow("Source App already registered: slack");
});

it("returns typed unsupported instead of silently emulating an operation", async () => {
  const result = await executeSourceThreadCommand({
    adapter: fakeSourceApp({ interactiveActions: false }),
    command: {
      type: "approve",
      commandId: "cmd_1",
      actor: { kind: "human", id: "U1" },
      requestId: "approval_1",
    },
  });
  expect(result).toEqual({ outcome: "unsupported_capability", capability: "interactiveActions" });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
corepack pnpm vitest run packages/core/test/source-app.test.ts packages/delivery-contract/test/observation.test.ts packages/source-app-runtime/test/registry.test.ts packages/source-app-runtime/test/commands.test.ts
```

Expected: FAIL because the Source App types, registry, and shared command service do not exist.

- [ ] **Step 3: Implement the strict schemas, typed registry, and shared command service**

The command vocabulary is closed:

```ts
export type SourceThreadCommand =
  | { type: "status"; commandId: string; actor: OpenTagActorRef }
  | { type: "cancel"; commandId: string; actor: OpenTagActorRef; reason: string }
  | { type: "approve"; commandId: string; actor: OpenTagActorRef; requestId: string }
  | { type: "reject"; commandId: string; actor: OpenTagActorRef; requestId: string }
  | { type: "bind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string }
  | { type: "unbind"; commandId: string; actor: OpenTagActorRef; bindingDigest: string };
```

Provider packages may parse native buttons/comments into this union. `@opentag/source-app-runtime` receives injected status, cancellation, approval, and binding authority ports; it never imports the dispatcher, Control Plane, store implementation, or a Provider package.

- [ ] **Step 4: Add an architectural test proving a fake second App requires no lifecycle edit**

The test imports a deterministic fake App, registers one exact installation, normalizes one mention, reads bounded context, renders one terminal presentation, prepares and delivers it through the same registry entry, and rejects a delivery whose binding digest or credential generation differs. It does not import Slack, hosted-runs, or store internals.

- [ ] **Step 5: Run package tests and builds**

```bash
corepack pnpm vitest run packages/core/test packages/delivery-contract/test packages/source-app-runtime/test packages/dispatcher/test/source-thread-control.test.ts
corepack pnpm --filter @opentag/core build
corepack pnpm --filter @opentag/delivery-contract build
corepack pnpm --filter @opentag/source-app-runtime build
corepack pnpm --filter @opentag/dispatcher build
```

- [ ] **Step 6: Commit the contract boundary**

```bash
git add packages/core/src/source-app.ts packages/core/src/channel-protocol.ts packages/core/src/index.ts packages/core/test/source-app.test.ts packages/delivery-contract/src/observation.ts packages/delivery-contract/src/index.ts packages/delivery-contract/test/observation.test.ts packages/source-app-runtime/package.json packages/source-app-runtime/tsconfig.json packages/source-app-runtime/tsup.config.ts packages/source-app-runtime/src/definition.ts packages/source-app-runtime/src/registry.ts packages/source-app-runtime/src/commands.ts packages/source-app-runtime/src/index.ts packages/source-app-runtime/test/registry.test.ts packages/source-app-runtime/test/commands.test.ts packages/dispatcher/src/source-app-registry.ts packages/dispatcher/src/source-app-commands.ts packages/dispatcher/src/source-thread-control.ts packages/dispatcher/src/index.ts packages/dispatcher/package.json packages/dispatcher/tsconfig.json tsconfig.json pnpm-lock.yaml
git commit -m "refactor: define the Source App adapter boundary"
```

## Task 2: Add Encrypted Relay Content Custody and Source Withdrawal

**Files:**

- Create: `apps/control-plane/src/modules/source-content/schema.ts`
- Create: `apps/control-plane/src/modules/source-content/crypto.ts`
- Create: `apps/control-plane/src/modules/source-content/index.ts`
- Create: `apps/control-plane/src/modules/source-content/grants.ts`
- Create: `apps/control-plane/src/modules/source-content/worker.ts`
- Modify: `apps/control-plane/src/config.ts`
- Modify: `apps/control-plane/src/database/schema.ts`
- Modify: `apps/control-plane/src/database/migrations.ts`
- Modify: `apps/control-plane/src/modules/jobs/index.ts`
- Modify: `apps/control-plane/src/modules/jobs/worker.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Modify: `apps/control-plane/src/application.ts`
- Create: `apps/control-plane/test/source-content.postgres.test.ts`
- Create: `apps/control-plane/test/source-content-deletion.postgres.test.ts`
- Create: `apps/control-plane/test/source-content-purge.postgres.test.ts`
- Create: `apps/control-plane/test/source-content-grants.postgres.test.ts`
- Modify: `apps/control-plane/test/config.test.ts`
- Modify: `apps/control-plane/test/schema-parity.postgres.test.ts`

**Interfaces:**

- Consumes: operator-provided relay content KEK Secret Reference, Organization/Installation/source-version identity, normalized bounded Source Context, Run/Attempt/fence identity, and the existing leased jobs worker.
- Produces: `RelayContentCustody`, encrypted `SourceContextEnvelopeRef`, one-time `SourceContentReadGrant`, authenticated source withdrawal, lifecycle purge, content-free replay tombstones, and an injected `SourceContentInvalidationAuthority` port. Custody owns content and withdrawal truth; it never imports hosted-runs or writes Run/Attempt state directly.

The invalidation port is deliberately coordinator-owned:

```ts
export interface SourceContentInvalidationAuthority {
  invalidate(input: {
    organizationId: string;
    sourceVersionRef: string;
    contentIds: string[];
    reason: "source_content_deleted";
    commandId: string;
  }): Promise<ImmutableInvalidationReceipt>;
}
```

The withdrawal worker records and idempotently replays the authenticated source withdrawal, calls this injected port, stores the immutable receipt, and only then closes the withdrawal obligation. A crash at any boundary replays the same `commandId`; it cannot invent a second cancellation or bypass coordinator fencing.

The self-hosted profile uses PostgreSQL-only envelope encryption:

```text
32-byte operator-provided KEK with explicit keyVersion
  wraps
random 32-byte per-object DEK
  encrypts with AES-256-GCM
bounded normalized payload / Source Context Envelope
```

Authenticated associated data binds Organization, Installation, Source App, source delivery/message/version, purpose, and content ID. Store ciphertext, content nonce/tag, wrapped DEK, wrapping nonce/tag, AAD digest, key version, source-version reverse index, lifecycle timestamps, and deletion state. The plaintext KEK and DEK never enter PostgreSQL or logs.

Use these dedicated tables:

```text
cp_source_content
cp_source_content_dependency
cp_source_content_read_grant
cp_source_replay_tombstone
```

- [ ] **Step 1: Add failing encryption, restart, and wrong-context tests**

```ts
it("decrypts only under the exact tenant, source version, and purpose", async () => {
  const stored = await custody.store(sourceContentFixture());
  await expect(custody.read(exactReadGrant(stored))).resolves.toMatchObject({ text: "fix this" });
  await expect(custody.read(exactReadGrant(stored, { organizationId: "other" })))
    .rejects.toThrow("source_content_context_mismatch");
});
```

Recreate the custody service with the same KEK and PostgreSQL rows and prove decryption survives process restart. Use a different KEK and prove readiness fails closed without exposing ciphertext or key material.

- [ ] **Step 2: Add failing one-time Attempt-bound grant tests**

The grant stores only a token hash and binds `runId`, `attemptId`, fence digest, content IDs, purpose, and expiry. Exact first use succeeds and atomically consumes it; replay, stale fence, wrong Attempt, wrong content, and expiry fail closed.

- [ ] **Step 3: Add failing source deletion and purge races**

Verified source deletion atomically revokes reads, invokes the coordinator invalidation port for every dependent nonterminal intent as `source_content_deleted`, and preserves the immutable Envelope record without readable content. Race deletion against claim and Attempt read: claim/read and deletion are serialized, and a deletion winner releases no new plaintext. If a read won immediately before withdrawal, the coordinator still fences the exact Attempt and applies the material-action rules in Task 4; deletion never pretends already released plaintext or an external effect can be clawed back. Terminal content purges at seven days, while a 90-day tombstone retains only replay identity/digest and cannot reconstruct plaintext.

- [ ] **Step 4: Run focused tests and confirm RED**

```bash
corepack pnpm vitest run apps/control-plane/test/source-content.postgres.test.ts apps/control-plane/test/source-content-deletion.postgres.test.ts apps/control-plane/test/source-content-purge.postgres.test.ts apps/control-plane/test/source-content-grants.postgres.test.ts apps/control-plane/test/config.test.ts
```

- [ ] **Step 5: Implement custody, grants, withdrawal, and purge jobs**

Use `node:crypto` AES-256-GCM with random nonces and keys. Zero transient key/plaintext buffers when practical, redact all errors, and expose only stable reason codes. Missing/invalid KEK makes relay readiness fail and prevents Provider ACK. Register closed job kinds for source withdrawal and lifecycle purge; recovery is idempotent. Wire the invalidation authority through `application.ts`/`runtime.ts`; content code may call the port but may not depend on the hosted-runs module implementation.

- [ ] **Step 6: Add backup/restore contract evidence**

The deterministic test exports PostgreSQL, restores it into a fresh database, starts the service with the same KEK, reads non-expired content through a fresh exact grant, rejects revoked/purged content, and proves tombstones still block duplicate delivery.

- [ ] **Step 7: Run schema parity and Control Plane build**

```bash
corepack pnpm vitest run apps/control-plane/test/source-content.postgres.test.ts apps/control-plane/test/source-content-deletion.postgres.test.ts apps/control-plane/test/source-content-purge.postgres.test.ts apps/control-plane/test/source-content-grants.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 8: Commit encrypted source custody**

```bash
git add apps/control-plane/src/modules/source-content/schema.ts apps/control-plane/src/modules/source-content/crypto.ts apps/control-plane/src/modules/source-content/index.ts apps/control-plane/src/modules/source-content/grants.ts apps/control-plane/src/modules/source-content/worker.ts apps/control-plane/src/config.ts apps/control-plane/src/database/schema.ts apps/control-plane/src/database/migrations.ts apps/control-plane/src/modules/jobs/index.ts apps/control-plane/src/modules/jobs/worker.ts apps/control-plane/src/runtime.ts apps/control-plane/src/application.ts apps/control-plane/test/source-content.postgres.test.ts apps/control-plane/test/source-content-deletion.postgres.test.ts apps/control-plane/test/source-content-purge.postgres.test.ts apps/control-plane/test/source-content-grants.postgres.test.ts apps/control-plane/test/config.test.ts apps/control-plane/test/schema-parity.postgres.test.ts
git commit -m "feat: encrypt and expire relay source context"
```

## Task 3: Add Generic Durable Source Ingress and Processing Obligations

**Files:**

- Create: `apps/control-plane/src/modules/source-ingress/schema.ts`
- Create: `apps/control-plane/src/modules/source-ingress/index.ts`
- Create: `apps/control-plane/src/modules/source-ingress/worker.ts`
- Modify: `apps/control-plane/src/database/schema.ts`
- Modify: `apps/control-plane/src/database/migrations.ts`
- Modify: `apps/control-plane/src/modules/jobs/index.ts`
- Modify: `apps/control-plane/src/modules/jobs/worker.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Modify: `apps/control-plane/src/application.ts`
- Modify: `apps/control-plane/package.json`
- Modify: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/test/source-ingress.postgres.test.ts`
- Create: `apps/control-plane/test/source-ingress-crash-boundaries.postgres.test.ts`
- Modify: `apps/control-plane/test/schema-parity.postgres.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: a verified `SourceAppDefinition` from `@opentag/source-app-runtime`, tenant/installation/binding identity, raw-byte digest, encrypted custody port, and existing leased job worker. This task adds the runtime package to the Control Plane production manifest and TypeScript references before the first Control Plane build.
- Produces: `SourceIngressService.reserve()`, `SourceIngressWorker.processNext()`, `IngressReservation`, encrypted Source Context references owned by `RelayContentCustody`, and `SourceResolution`.

Use the existing `cp_job` row as the durable Ingress Processing Obligation. Add these provider-neutral tables:

```text
cp_source_app_installation
cp_source_binding
cp_ingress_reservation
cp_source_resolution
```

The reservation and `cp_job(job_kind = 'source_ingress.process')` insert must share one PostgreSQL transaction.

- [ ] **Step 1: Add failing atomicity and replay tests**

```ts
it("commits reservation and processing obligation before provider ack", async () => {
  const result = await ingress.reserve(verifiedSlackDelivery("evt_1"));
  expect(result).toMatchObject({ outcome: "reserved", mayAcknowledge: true });
  await expectReservation("evt_1");
  await expectPendingJob("source_ingress.process", "evt_1");
});

it("conflicts on the same delivery id with a different digest", async () => {
  await ingress.reserve(verifiedSlackDelivery("evt_1", "sha256:a"));
  await expect(ingress.reserve(verifiedSlackDelivery("evt_1", "sha256:b")))
    .resolves.toEqual({ outcome: "conflict", mayAcknowledge: false });
});
```

- [ ] **Step 2: Add crash injection after each write and confirm full rollback**

Cover failure after reservation insert, payload reference insert, and job insert. After each injected failure, assert there is no acknowledgement permission and no partial row.

- [ ] **Step 3: Run the tests and confirm RED**

```bash
corepack pnpm vitest run apps/control-plane/test/source-ingress.postgres.test.ts apps/control-plane/test/source-ingress-crash-boundaries.postgres.test.ts
```

- [ ] **Step 4: Implement the schema, transaction, leased processing worker, and closed outcomes**

The worker must settle exactly one of:

```ts
type SourceResolution =
  | { kind: "accepted"; runId: string }
  | { kind: "waiting_for_runner"; runId: string }
  | { kind: "follow_up_queued"; followUpId: string }
  | { kind: "binding_change_pending"; code: string }
  | { kind: "setup_required"; code: string }
  | { kind: "not_authorized"; code: string }
  | { kind: "invalid_request"; code: string }
  | { kind: "rate_limited"; retryAt: string }
  | { kind: "queue_full"; code: string }
  | { kind: "storage_quota_exceeded"; code: string }
  | { kind: "source_content_deleted"; code: string }
  | { kind: "temporarily_unavailable"; code: string };
```

No trusted delivery may remain permanently `processing`; poisoned items become a durable closed resolution plus operator attention.

- [ ] **Step 5: Integrate reservation with encrypted content custody**

The reservation transaction stores ciphertext through `RelayContentCustody`, records only the immutable content reference/digest on the Reservation and processing job, and exposes no plaintext in job payloads, logs, audit, or Source Resolution. If encryption, key resolution, or ciphertext persistence fails, the transaction rolls back and `mayAcknowledge` remains false. Processing reads normalized content through an internal exact-purpose grant; the paired Runner receives plaintext only later through its one-time Attempt-bound grant.

- [ ] **Step 6: Run Control Plane tests and schema parity**

```bash
corepack pnpm vitest run apps/control-plane/test/source-content.postgres.test.ts apps/control-plane/test/source-content-deletion.postgres.test.ts apps/control-plane/test/source-ingress.postgres.test.ts apps/control-plane/test/source-ingress-crash-boundaries.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts apps/control-plane/test/jobs.postgres.test.ts
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 7: Commit durable ingress**

```bash
git add apps/control-plane/src/modules/source-ingress/schema.ts apps/control-plane/src/modules/source-ingress/index.ts apps/control-plane/src/modules/source-ingress/worker.ts apps/control-plane/src/database/schema.ts apps/control-plane/src/database/migrations.ts apps/control-plane/src/modules/jobs/index.ts apps/control-plane/src/modules/jobs/worker.ts apps/control-plane/src/runtime.ts apps/control-plane/src/application.ts apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/test/source-ingress.postgres.test.ts apps/control-plane/test/source-ingress-crash-boundaries.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts pnpm-lock.yaml
git commit -m "feat: reserve Source App ingress before acknowledgement"
```

## Task 4: Make Hosted Admission Runner-Offline-Safe and Deadline-Bounded

**Files:**

- Modify: `packages/control-protocol/src/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `apps/control-plane/src/modules/hosted-runs/schema.ts`
- Modify: `apps/control-plane/src/modules/hosted-runs/index.ts`
- Modify: `apps/control-plane/src/modules/source-content/index.ts`
- Modify: `apps/control-plane/src/modules/source-content/grants.ts`
- Modify: `apps/control-plane/src/application.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Modify: `apps/control-plane/test/hosted-coordinator.postgres.test.ts`
- Modify: `apps/control-plane/test/control-v1-transport.postgres.test.ts`
- Modify: `apps/control-plane/test/source-content-grants.postgres.test.ts`
- Create: `apps/control-plane/test/hosted-run-races.postgres.test.ts`
- Modify: `apps/control-plane/test/schema-parity.postgres.test.ts`

**Interfaces:**

- Consumes: encrypted `SourceContextEnvelope` ref/digest, immutable source/binding identity, paired Runner affinity, `queueClaimDeadline`, permission ceiling, Admission-frozen `PublicationPolicy.mode` (`proposal_only | pull_request`), its matching `CompletionContract.mode` (`proposal_ready | pull_request_ready`), source-content grant issuer, and authenticated source invalidation commands. The binding must authorize `pull_request` before Admission; approval cannot upgrade the mode later.
- Produces: queued hosted Runs whose Placement, claim, cancellation, source invalidation, expiry, Attempt, and terminal writes remain owned by `HostedRunCoordinator`, plus a one-time Attempt/fence-bound content grant issued only after successful Placement and immutable invalidation receipts returned to content custody.

- [ ] **Step 1: Replace the existing runner-not-ready admission expectation with a failing waiting-state test**

```ts
it("admits while the paired Runner is offline", async () => {
  const admitted = await hosted.admit(hostedAdmission({
    runnerId: "runner_1",
    queueClaimDeadline: "2026-08-29T00:00:00.000Z",
  }));
  expect(admitted.view.status).toBe("waiting_for_runner");
  expect(await hosted.claim(runnerClaim("runner_1"))).toEqual({ outcome: "empty" });
});
```

- [ ] **Step 2: Add claim-versus-expiry, duplicate admission, cancellation, source-deletion, and stale-fence race tests**

Use two PostgreSQL clients and barriers. Assert exactly one of claim or expiry wins, cancellation blocks later claim, and a stale Attempt cannot progress or complete. Race `invalidateSourceContent()` against queued claim, one-time content read, running Attempt heartbeat, cancellation, and terminal completion. A queued deletion winner terminally cancels with `source_content_deleted`; a live Attempt is fenced and becomes `interrupted`. If material start may have crossed, preserve `outcome_unknown` and create no replacement Attempt. A terminal Run is not rewritten, although custody still revokes/purges its content.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
corepack pnpm vitest run apps/control-plane/test/hosted-coordinator.postgres.test.ts apps/control-plane/test/hosted-run-races.postgres.test.ts apps/control-plane/test/control-v1-transport.postgres.test.ts
```

- [ ] **Step 4: Add immutable source/queue/publication fields and implement waiting/expiry semantics**

Do not add a second top-level state vocabulary. Migrate the hosted coordinator onto the accepted canonical Run lifecycle and keep availability, Attempt, approval, Publication, completion, and delivery as separate states or projections. A successful claim transaction creates the Attempt/fence and one source-content read grant bound to that exact tuple; claim failure or rollback creates neither:

```ts
type CanonicalRunStatus =
  | "queued"
  | "assigned"
  | "running"
  | "needs_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out";
```

`waiting_for_runner` is a Source Resolution/query presentation over `queued`; `waiting_for_approval` is a presentation over `needs_approval`; `proposal_ready` and `ready_for_review` are Completion/Work Thread projections over terminal `succeeded`; `publication_pending` is a Publication/Attempt projection while the Run remains `running`; `outcome_unknown` is an external-operation or delivery outcome that blocks completion and can coexist with `interrupted`. Status reads, heartbeats, reconnects, config changes, and relay restart never extend the deadline.

- [ ] **Step 5: Implement cancellation authority and material-action-aware retry**

Before material start, an expired Attempt may be replaced within the original deadline. After `ExternalOperationIntent` or ambiguous external effect, set `outcome_unknown`, preserve reconciliation identity, and create no replacement Attempt.

Implement `HostedRunCoordinator.invalidateSourceContent()` as the sole `SourceContentInvalidationAuthority`. In one coordinator transaction it locks dependent Runs/Attempts, revokes future claim/read authority, fences a live Attempt, applies the queued/running/material-start outcomes above, writes one immutable receipt keyed by `commandId`, and returns the same receipt on replay. Content custody may not emulate this transaction with direct table updates.

- [ ] **Step 6: Run the coordinator suite and schema parity**

```bash
corepack pnpm vitest run apps/control-plane/test/hosted-coordinator.postgres.test.ts apps/control-plane/test/hosted-run-races.postgres.test.ts apps/control-plane/test/source-content-grants.postgres.test.ts apps/control-plane/test/material-actions.postgres.test.ts apps/control-plane/test/permissions.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts
corepack pnpm --filter @opentag/control-protocol build
corepack pnpm --filter @opentag/client build
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 7: Commit the offline-safe hosted lifecycle**

```bash
git add packages/control-protocol/src/index.ts packages/client/src/index.ts apps/control-plane/src/modules/hosted-runs/schema.ts apps/control-plane/src/modules/hosted-runs/index.ts apps/control-plane/src/modules/source-content/index.ts apps/control-plane/src/modules/source-content/grants.ts apps/control-plane/src/application.ts apps/control-plane/src/runtime.ts apps/control-plane/test/hosted-coordinator.postgres.test.ts apps/control-plane/test/hosted-run-races.postgres.test.ts apps/control-plane/test/control-v1-transport.postgres.test.ts apps/control-plane/test/source-content-grants.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts
git commit -m "feat: admit finite work while the Runner is offline"
```

## Task 5: Implement Slack as the First Typed Source App

**Files:**

- Create: `packages/slack/src/source-app.ts`
- Create: `packages/slack/src/context.ts`
- Modify: `packages/slack/src/ingress.ts`
- Modify: `packages/slack/src/normalize.ts`
- Modify: `packages/slack/src/render.ts`
- Modify: `packages/slack/src/delivery-adapter.ts`
- Modify: `packages/slack/src/events.ts`
- Modify: `packages/slack/src/index.ts`
- Create: `packages/slack/test/source-app.test.ts`
- Create: `packages/slack/test/source-app-conformance.test.ts`
- Create: `apps/control-plane/src/modules/slack-ingress/index.ts`
- Modify: `apps/control-plane/src/application.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Modify: `apps/control-plane/package.json`
- Modify: `apps/control-plane/tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/control-plane/test/slack-ingress.postgres.test.ts`
- Modify: `apps/control-plane/test/application.test.ts`

**Interfaces:**

- Consumes: `SourceAppDefinition`, generic Source Ingress service, hosted Admission, Slack signing secret/Bot token Secret References, and existing Slack normalization/rendering code.
- Produces: one explicit-registry Slack Adapter and two Control Plane routes for Events API and interactivity.

The certified self-hosted transport is Slack Events API + interactivity webhooks + Web API. Keep Socket Mode for `local_direct`; do not certify Socket Mode as offline-safe.

- [ ] **Step 1: Add failing conformance tests for one mention, one verified deletion, one control action, and one unsupported event**

```ts
it("normalizes only explicit app mentions", async () => {
  const normalized = await slackSourceApp.ingress.normalize(slackAppMentionFixture());
  expect(normalized?.trigger).toBe("mention");
  expect(normalized?.source.thread?.id).toBe("C1:1700000000.000100");
});

it("does not turn an ordinary channel message into ambient work", async () => {
  expect(await slackSourceApp.ingress.normalize(slackOrdinaryMessageFixture())).toBeNull();
});

it("maps an authenticated message deletion to source withdrawal", async () => {
  const normalized = await slackSourceApp.ingress.normalize(slackMessageDeletedFixture());
  expect(normalized).toMatchObject({ trigger: "source_content_deleted" });
});
```

- [ ] **Step 2: Add failing HTTP tests proving ACK follows reservation commit**

Inject a transaction failure and assert a non-success Slack response. Inject a crash after commit, replay the same envelope, and assert one Reservation and one Run.

- [ ] **Step 3: Run Slack and Control Plane tests and confirm RED**

```bash
corepack pnpm vitest run packages/slack/test/source-app.test.ts packages/slack/test/source-app-conformance.test.ts apps/control-plane/test/slack-ingress.postgres.test.ts apps/control-plane/test/application.test.ts
```

- [ ] **Step 4: Implement the Slack ports by composing existing functions**

Move provider-neutral command handling out of `packages/slack/src/events.ts`. Keep only raw verification/challenge, Slack identity/thread mapping, bounded thread retrieval, authenticated deletion normalization, native render, Web API execution, and reconciliation in `@opentag/slack`. The Control Plane forwards verified deletion to `RelayContentCustody` and the Source Ingress worker; the Adapter does not mutate Run state directly.

- [ ] **Step 5: Enforce shared-thread authority**

Tests must cover ordinary member invoke/status, requester/operator cancellation, configured Approver approval, admin-only binding, guest denial, and rejection of any message/button that broadens the frozen permission or Publication ceiling.

- [ ] **Step 6: Run all Slack tests and builds**

```bash
corepack pnpm vitest run packages/slack/test apps/control-plane/test/slack-ingress.postgres.test.ts apps/control-plane/test/source-ingress.postgres.test.ts
corepack pnpm --filter @opentag/slack build
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 7: Commit the first Source App**

```bash
git add packages/slack/src/source-app.ts packages/slack/src/context.ts packages/slack/src/ingress.ts packages/slack/src/normalize.ts packages/slack/src/render.ts packages/slack/src/delivery-adapter.ts packages/slack/src/events.ts packages/slack/src/index.ts packages/slack/test/source-app.test.ts packages/slack/test/source-app-conformance.test.ts apps/control-plane/src/modules/slack-ingress/index.ts apps/control-plane/src/application.ts apps/control-plane/src/runtime.ts apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/test/slack-ingress.postgres.test.ts apps/control-plane/test/application.test.ts pnpm-lock.yaml
git commit -m "feat: admit Slack threads through the team relay"
```

## Task 6: Extract the Delivery Runtime and Add a PostgreSQL Relay Repository

**Files:**

- Create: `packages/delivery-runtime/package.json`
- Create: `packages/delivery-runtime/tsconfig.json`
- Create: `packages/delivery-runtime/tsup.config.ts`
- Create: `packages/delivery-runtime/src/repository.ts`
- Create: `packages/delivery-runtime/src/provider-registry.ts`
- Create: `packages/delivery-runtime/src/side-effect-kernel.ts`
- Create: `packages/delivery-runtime/src/producer.ts`
- Create: `packages/delivery-runtime/src/index.ts`
- Create: `packages/delivery-runtime/test/provider-registry.test.ts`
- Create: `packages/delivery-runtime/test/side-effect-kernel.test.ts`
- Create: `packages/delivery-runtime/test/producer.test.ts`
- Modify: `packages/store/src/delivery-schema.ts`
- Modify: `packages/store/src/delivery-repository.ts`
- Modify: `packages/store/test/delivery-journal.test.ts`
- Replace with compatibility re-exports: `packages/dispatcher/src/delivery/provider-registry.ts`
- Replace with compatibility re-exports: `packages/dispatcher/src/delivery/side-effect-kernel.ts`
- Replace with compatibility re-exports: `packages/dispatcher/src/delivery/producer.ts`
- Modify: `packages/dispatcher/test/delivery/provider-registry.test.ts`
- Modify: `packages/dispatcher/test/delivery/side-effect-kernel.test.ts`
- Modify: `packages/dispatcher/test/delivery/producer.test.ts`
- Modify: `packages/dispatcher/package.json`
- Modify: `packages/dispatcher/tsconfig.json`
- Modify: `packages/dispatcher/src/index.ts`
- Create: `apps/control-plane/src/modules/provider-delivery/schema.ts`
- Create: `apps/control-plane/src/modules/provider-delivery/repository.ts`
- Create: `apps/control-plane/src/modules/provider-delivery/worker.ts`
- Modify: `apps/control-plane/src/database/schema.ts`
- Modify: `apps/control-plane/src/database/migrations.ts`
- Modify: `apps/control-plane/src/modules/jobs/worker.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Modify: `apps/control-plane/package.json`
- Modify: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/test/provider-delivery.postgres.test.ts`
- Create: `apps/control-plane/test/provider-delivery-crash-boundaries.postgres.test.ts`
- Modify: `apps/control-plane/test/schema-parity.postgres.test.ts`
- Modify: `tsconfig.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: existing `DeliveryIntentV2`, Slack delivery adapter behavior, and the SQLite repository semantics proven in `@opentag/store`.
- Produces: dependency-light `@opentag/delivery-runtime`, a provider-neutral repository port, compatibility re-exports for `@opentag/dispatcher`, and a PostgreSQL repository implementing the same enqueue/claim/begin/settle/reconcile semantics used by `local_direct`.

- [ ] **Step 1: Add the new package and move the pure runtime without changing behavior**

`@opentag/delivery-runtime` may depend only on `@opentag/delivery-contract`, `@opentag/source-app-runtime`, and Node built-ins. It must not depend on `@opentag/store`, `@opentag/dispatcher`, a Provider package, SQLite, PostgreSQL, Hono, or Drizzle. Move `UnifiedDeliveryProducer` and `ProviderSideEffectKernel` into it. Replace `ProviderAdapterRegistry` with a compatibility facade that resolves the outbound port from the already-registered composite `SourceAppDefinition`; it must not maintain a second map or permit independently registered binding/credential generations. Keep temporary re-export files at the old dispatcher paths so current imports continue to compile during the migration.

Migrate `DeliveryErrorCode`, provider-neutral delivery owner/claim/begin/settlement shapes, and external-resource observations to the canonical vocabulary added to `@opentag/delivery-contract` in Task 1. `@opentag/store` imports it; the runtime imports only the contract. Remove Slack timestamp validation from the kernel: the Slack Adapter validates its native message identity and returns a canonical external-resource identity/digest before settlement.

- [ ] **Step 2: Define the repository interface from the kernel's actual calls**

```ts
export type Awaitable<T> = T | Promise<T>;

export interface DeliveryKernelRepository {
  recordIntent(intent: DeliveryIntentV2, payload: unknown): Awaitable<void>;
  claimNext(): Awaitable<DeliveryClaim | null>;
  renewLease(claim: DeliveryClaim): Awaitable<DeliveryClaim | null>;
  getIntent(claim: DeliveryClaim): Awaitable<StoredDeliveryIntent | null>;
  releaseUnusedClaim(claim: DeliveryClaim): Awaitable<boolean>;
  markBegin(input: DeliveryBegin): Awaitable<DeliveryBegin | null>;
  settleOrReadTerminal(input: DeliverySettlementInput): Awaitable<DeliverySettlement>;
  finalizeStrandedBegun(input: {
    before: string;
    evidenceDigest: string;
    outcomeRecordedAt?: string;
  }): Awaitable<number>;
  findAcceptedExternalResource(input: {
    intent: DeliveryIntentV2;
    statusMessageId: string;
  }): Awaitable<
    | { outcome: "none" | "ambiguous" }
    | { outcome: "exact"; externalResourceId: string; externalResourceDigest: string }
  >;
}
```

Add an adapter in `@opentag/store` only if its synchronous return types cannot structurally satisfy this port; do not move SQLite code into the runtime package. Run existing SQLite delivery tests unchanged before adding PostgreSQL.

- [ ] **Step 3: Add failing PostgreSQL contract and crash-boundary tests**

Cover intent insert, duplicate/conflict, claim exclusivity, lease expiry, begin marker, timeout, ambiguous write, exact reconciliation, coalescing, deadline abandonment, and restart.

- [ ] **Step 4: Run tests and confirm RED**

```bash
corepack pnpm vitest run packages/delivery-contract/test/observation.test.ts packages/delivery-runtime/test apps/control-plane/test/provider-delivery.postgres.test.ts apps/control-plane/test/provider-delivery-crash-boundaries.postgres.test.ts
```

- [ ] **Step 5: Implement PostgreSQL tables and repository**

Store immutable intents, payload custody reference, claim/lease/fence, begin markers, terminal observation, supersession relation, frozen deadline, and authoritative provider resource identity. No Control Plane module may implement a second retry loop outside the kernel.

- [ ] **Step 6: Implement current-truth coalescing**

If pending `received`/`running` presentations are overtaken by terminal Run truth, supersede them and enqueue one terminal summary. Delivery failure or deadline expiry never changes Run state.

- [ ] **Step 7: Run both repository implementations and build**

```bash
corepack pnpm vitest run packages/delivery-contract/test/observation.test.ts packages/store/test/delivery-journal.test.ts packages/delivery-runtime/test packages/dispatcher/test/delivery apps/control-plane/test/provider-delivery.postgres.test.ts apps/control-plane/test/provider-delivery-crash-boundaries.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts
corepack pnpm --filter @opentag/delivery-runtime build
corepack pnpm --filter @opentag/dispatcher build
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 8: Commit the delivery runtime and relay repository**

```bash
git add packages/delivery-runtime/package.json packages/delivery-runtime/tsconfig.json packages/delivery-runtime/tsup.config.ts packages/delivery-runtime/src/repository.ts packages/delivery-runtime/src/provider-registry.ts packages/delivery-runtime/src/side-effect-kernel.ts packages/delivery-runtime/src/producer.ts packages/delivery-runtime/src/index.ts packages/delivery-runtime/test/provider-registry.test.ts packages/delivery-runtime/test/side-effect-kernel.test.ts packages/delivery-runtime/test/producer.test.ts packages/store/src/delivery-schema.ts packages/store/src/delivery-repository.ts packages/store/test/delivery-journal.test.ts packages/dispatcher/src/delivery/provider-registry.ts packages/dispatcher/src/delivery/side-effect-kernel.ts packages/dispatcher/src/delivery/producer.ts packages/dispatcher/src/index.ts packages/dispatcher/package.json packages/dispatcher/tsconfig.json packages/dispatcher/test/delivery/provider-registry.test.ts packages/dispatcher/test/delivery/side-effect-kernel.test.ts packages/dispatcher/test/delivery/producer.test.ts apps/control-plane/src/modules/provider-delivery/schema.ts apps/control-plane/src/modules/provider-delivery/repository.ts apps/control-plane/src/modules/provider-delivery/worker.ts apps/control-plane/src/database/schema.ts apps/control-plane/src/database/migrations.ts apps/control-plane/src/modules/jobs/worker.ts apps/control-plane/src/runtime.ts apps/control-plane/package.json apps/control-plane/tsconfig.json apps/control-plane/test/provider-delivery.postgres.test.ts apps/control-plane/test/provider-delivery-crash-boundaries.postgres.test.ts apps/control-plane/test/schema-parity.postgres.test.ts tsconfig.json pnpm-lock.yaml
git commit -m "feat: persist team relay delivery in PostgreSQL"
```

## Task 7: Harden Paired Runner Reconnect, Workspace, and ACP Recovery

**Files:**

- Modify: `packages/local-runtime/src/control-v1.ts`
- Modify: `packages/local-runtime/src/daemon.ts`
- Modify: `packages/local-runtime/src/config.ts`
- Modify: `packages/local-runtime/src/runtime.ts`
- Modify: `packages/runner/src/executor.ts`
- Modify: `packages/runner/src/acp-executor.ts`
- Modify: `packages/runner/src/git.ts`
- Modify: `packages/runner/src/result.ts`
- Modify: `packages/local-runtime/test/control-v1.test.ts`
- Modify: `packages/local-runtime/test/acp-daemon.test.ts`
- Modify: `packages/local-runtime/test/runtime-authority.test.ts`
- Modify: `packages/runner/test/acp-executor.test.ts`
- Modify: `packages/runner/test/result.test.ts`

**Interfaces:**

- Consumes: Control V1 paired credential/generation, hosted claim/lease/fence, exact workspace identity, ACP Harness, permission resolver, and material-action reporter.
- Produces: `AttemptWorkspaceAttestation`, `AttemptInterruptionEvidence`, immutable proposal result, and stale-fence-safe lifecycle receipts.

- [ ] **Step 1: Add failing reconnect and stale-workspace tests**

```ts
it("continues only while lease, fence, and workspace identity remain current", async () => {
  const continued = await reconnectAttempt({ leaseCurrent: true, fence: 2, workspaceDigest: "sha256:w" });
  expect(continued.outcome).toBe("continued");
});

it("preserves but never adopts an expired Attempt workspace", async () => {
  const next = await recoverExpiredAttempt(expiredAttemptFixture());
  expect(next.oldWorkspace.state).toBe("interrupted_evidence");
  expect(next.newWorkspace.id).not.toBe(next.oldWorkspace.id);
});
```

- [ ] **Step 2: Add cancellation/material-action race tests**

Assert cancellation invalidates future authority, stale completion is rejected, process-stop observation remains evidence, and a possibly crossed external effect becomes `outcome_unknown`.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
corepack pnpm vitest run packages/local-runtime/test/control-v1.test.ts packages/local-runtime/test/acp-daemon.test.ts packages/local-runtime/test/runtime-authority.test.ts packages/runner/test/acp-executor.test.ts packages/runner/test/result.test.ts
```

- [ ] **Step 4: Redeem source content through the one-time claim grant**

After a successful hosted claim, Control V1 returns only the encrypted content reference plus one opaque read token. The local runtime redeems it over the authenticated relay connection before starting ACP, verifies the returned envelope digest against Admission, passes plaintext directly into the Attempt context, and never writes it to local config, logs, or durable projection payloads. Replay, stale fence, wrong Attempt, wrong content, or expiry stops before Agent launch.

- [ ] **Step 5: Implement exact workspace attestation and interruption evidence**

Never clean, reset, checkout, stash, delete, or reuse a stale workspace automatically. An authorized replacement Attempt creates a new isolated worktree from the frozen revision.

- [ ] **Step 6: Separate ACP progress from authoritative external receipts**

`tool_call_update=completed` is reported evidence only. External operation success requires a separately correlated authoritative receipt; ambiguous disconnect remains unknown.

- [ ] **Step 7: Run local runtime and Runner suites**

```bash
corepack pnpm vitest run packages/local-runtime/test packages/runner/test
corepack pnpm --filter @opentag/local-runtime build
corepack pnpm --filter @opentag/runner build
```

- [ ] **Step 8: Commit recovery hardening**

```bash
git add packages/local-runtime/src/control-v1.ts packages/local-runtime/src/daemon.ts packages/local-runtime/src/config.ts packages/local-runtime/src/runtime.ts packages/local-runtime/test/control-v1.test.ts packages/local-runtime/test/acp-daemon.test.ts packages/local-runtime/test/runtime-authority.test.ts packages/runner/src/executor.ts packages/runner/src/acp-executor.ts packages/runner/src/git.ts packages/runner/src/result.ts packages/runner/test/acp-executor.test.ts packages/runner/test/result.test.ts
git commit -m "fix: preserve truthful Runner interruption boundaries"
```

## Task 8: Make Proposal-Ready the Default Completion Contract

**Files:**

- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/presentation.ts`
- Modify: `packages/control-protocol/src/completion.ts`
- Modify: `packages/governance/src/evaluate.ts`
- Modify: `packages/dispatcher/src/completion-governance.ts`
- Create: `apps/control-plane/src/modules/publication-candidates/schema.ts`
- Create: `apps/control-plane/src/modules/publication-candidates/index.ts`
- Modify: `apps/control-plane/src/database/schema.ts`
- Modify: `apps/control-plane/src/database/migrations.ts`
- Modify: `apps/control-plane/src/modules/hosted-runs/index.ts`
- Create: `apps/control-plane/test/publication-candidates.postgres.test.ts`
- Modify: `apps/control-plane/test/hosted-coordinator.postgres.test.ts`
- Modify: `packages/governance/test/evaluate.test.ts`

**Interfaces:**

- Consumes: successful Attempt result, exact workspace/base identity, diff/tree/commit digests, changed files, local verification evidence, and unresolved material-action state.
- Produces: immutable `PublicationCandidate`, `proposal_ready` Completion Assessment, and source-thread proposal presentation.

```ts
export type PublicationCandidate = {
  candidateId: string;
  runId: string;
  attemptId: string;
  projectTargetId: string;
  frozenBaseRevision: string;
  workspaceTreeDigest: string;
  patchDigest: string;
  changedFiles: string[];
  verificationEvidenceIds: string[];
  publicationPolicyDigest: string;
  createdAt: string;
};
```

- [ ] **Step 1: Add failing completion tests**

Assert Executor success alone is insufficient, missing verification is insufficient, unresolved external outcome blocks, and a complete immutable Candidate satisfies `proposal_ready` only for an Admission-frozen `proposal_only` contract. For an Admission-frozen `pull_request` contract, the same Candidate leaves the Run nonterminal under canonical `running` with `publication_pending` projection.

- [ ] **Step 2: Run tests and confirm RED**

```bash
corepack pnpm vitest run packages/governance/test/evaluate.test.ts apps/control-plane/test/publication-candidates.postgres.test.ts apps/control-plane/test/hosted-coordinator.postgres.test.ts
```

- [ ] **Step 3: Persist the candidate before workspace cleanup**

Freeze tree/patch/base/policy identities and verification evidence in the same lifecycle settlement transaction. Do not retain secret-bearing logs in the candidate.

- [ ] **Step 4: Implement truthful proposal presentation**

The source thread shows Candidate summary, changed files, verification, limitations, and exact next action. In `proposal_only`, an accepted Completion Assessment may terminally settle the Run as `succeeded` with `proposal_ready` projection. In `pull_request`, the Candidate is not terminal and the Run remains `running/publication_pending`. Neither path claims branch/PR/check/review/merge facts before authoritative evidence exists.

- [ ] **Step 5: Run completion and Control Plane tests**

```bash
corepack pnpm vitest run packages/governance/test apps/control-plane/test/publication-candidates.postgres.test.ts apps/control-plane/test/hosted-coordinator.postgres.test.ts
corepack pnpm --filter @opentag/governance build
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 6: Commit proposal-ready completion**

```bash
git add packages/core/src/schema.ts packages/core/src/presentation.ts packages/control-protocol/src/completion.ts packages/governance/src/evaluate.ts packages/governance/test/evaluate.test.ts packages/dispatcher/src/completion-governance.ts apps/control-plane/src/modules/publication-candidates/schema.ts apps/control-plane/src/modules/publication-candidates/index.ts apps/control-plane/src/database/schema.ts apps/control-plane/src/database/migrations.ts apps/control-plane/src/modules/hosted-runs/index.ts apps/control-plane/test/publication-candidates.postgres.test.ts apps/control-plane/test/hosted-coordinator.postgres.test.ts
git commit -m "feat: complete code work at verified proposal readiness"
```

## Task 9: Move GitHub Draft PR Creation Behind Exact Publication Approval

**Files:**

- Create: `packages/github/src/publisher.ts`
- Modify: `packages/github/src/pull-request.ts`
- Modify: `packages/github/src/apply.ts`
- Modify: `packages/github/src/completion-evidence.ts`
- Modify: `packages/github/src/index.ts`
- Modify: `packages/control-protocol/src/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/local-runtime/src/control-v1.ts`
- Modify: `packages/local-runtime/src/pr.ts`
- Modify: `packages/local-runtime/src/daemon.ts`
- Modify: `apps/control-plane/src/modules/hosted-runs/permissions.ts`
- Modify: `apps/control-plane/src/modules/hosted-runs/material-actions.ts`
- Create: `apps/control-plane/src/modules/publication-candidates/publisher.ts`
- Modify: `apps/control-plane/src/modules/publication-candidates/schema.ts`
- Modify: `apps/control-plane/src/application.ts`
- Modify: `apps/control-plane/src/runtime.ts`
- Create: `apps/control-plane/test/publication.postgres.test.ts`
- Create: `apps/control-plane/test/publication-transport.postgres.test.ts`
- Create: `apps/control-plane/test/material-action-transport.postgres.test.ts`
- Modify: `packages/github/test/pull-request.test.ts`
- Modify: `packages/github/test/completion-evidence.test.ts`
- Modify: `packages/local-runtime/test/pr.test.ts`
- Create: `packages/local-runtime/test/publication-control-v1.test.ts`

**Interfaces:**

- Consumes: exact approved Candidate, pre-authorized binding policy, owned Run Branch identity, local Git credentials, paired Runner identity/generation, and material-action intent/receipt protocol.
- Produces: coordinator-owned `PublicationIntent`, `BranchOwnershipRecord`, one-use `PublicationOperationCapability`, authoritative push/PR receipts, `outcome_unknown` reconciliation state, and exact-head `pull_request_ready` evidence. Git/GitHub credentials stay on the paired Runner; the relay stores authority and receipts but never receives repository credentials.

- [ ] **Step 1: Add a failing test proving proposal-only never calls GitHub**

```ts
it("does not publish under the default proposal-only policy", async () => {
  await settleCandidate(candidateFixture({ publication: "proposal_only" }));
  expect(github.createPullRequest).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add failing exact-approval and branch-ownership tests**

Reject wrong candidate digest, repository, remote, base, branch, approver, expired approval, unknown branch, and stale Attempt.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
corepack pnpm vitest run packages/github/test packages/local-runtime/test/pr.test.ts apps/control-plane/test/publication.postgres.test.ts apps/control-plane/test/material-actions.postgres.test.ts
```

- [ ] **Step 4: Replace automatic PR creation with an explicit Publisher**

The path is fixed:

```text
Admission-frozen pull_request policy
→ execution Candidate while Run remains running/publication_pending
→ exact approval of that Candidate
→ push owned Run Branch intent/receipt
→ create draft PR intent/receipt
→ observe exact PR head and configured checks
→ Completion Assessment
→ terminal succeeded with ready_for_review projection
```

An Admission-frozen `proposal_only` Run never enters this Publisher. Source text, a later approval, available credentials, or configuration changes cannot upgrade it to `pull_request`.

- [ ] **Step 5: Add the Publication Control V1 transport**

The relay creates the immutable `PublicationIntent`; the local Publisher performs the side effect. Extend Control V1 with lease/fence-protected publication claim, begin, observe, and reconcile messages. A claim returns a single-use, short-lived `PublicationOperationCapability` bound to the exact Organization, Run, Attempt/fence, Candidate digest, repository/remote/base, owned branch, expected head, operation step, operation idempotency key, paired Runner id/generation, and expiry.

Split Publication into two separately journaled operations:

```text
push_owned_branch
create_draft_pull_request
```

Before either Git/GitHub call, the Runner redeems the exact capability and the relay durably records `started`. After the call, the Runner submits an authoritative receipt or an explicit ambiguous observation under the same operation/fence. Capabilities are non-renewable and cannot be used for merge, target-branch write, force-push, another repository, another head, or another step. Cancellation, Attempt expiry, Runner generation change, or stale fence prevents an unstarted operation from beginning; it never erases a recorded start.

Add crash-boundary tests for capability issued/before begin, begin committed/before local call, remote push or PR committed/before response, receipt accepted/before response, stale duplicate receipt, reconnect, relay restart, and Runner restart. The transport test must prove that no Control V1 payload contains a Git/GitHub credential.

- [ ] **Step 6: Implement reconciliation before retry**

On ambiguous push/PR response, the paired Runner uses its local credentials to query the exact repository/remote branch/head or exact draft PR identity and returns a typed observation. A recorded `started` operation is never reissued until this reconciliation establishes authoritative absence. Exact presence settles the original operation; authoritative absence permits a new capability for the same operation identity; unresolved ambiguity remains `outcome_unknown`. Never issue a second blind write.

- [ ] **Step 7: Enforce v1 publication prohibitions**

Tests must prove no merge, force-push, target-branch write, unknown-branch takeover, auto-rebase, remote-branch delete, self-approval, or unknown-outcome waiver.

- [ ] **Step 8: Run publication and material-action suites**

```bash
corepack pnpm vitest run packages/github/test packages/local-runtime/test/pr.test.ts packages/local-runtime/test/publication-control-v1.test.ts apps/control-plane/test/publication.postgres.test.ts apps/control-plane/test/publication-transport.postgres.test.ts apps/control-plane/test/material-actions.postgres.test.ts apps/control-plane/test/material-action-transport.postgres.test.ts
corepack pnpm --filter @opentag/control-protocol build
corepack pnpm --filter @opentag/client build
corepack pnpm --filter @opentag/github build
corepack pnpm --filter @opentag/local-runtime build
corepack pnpm --filter @opentag/control-plane build
```

- [ ] **Step 9: Commit exact-approved Publication**

```bash
git add packages/github/src/publisher.ts packages/github/src/pull-request.ts packages/github/src/apply.ts packages/github/src/completion-evidence.ts packages/github/src/index.ts packages/github/test/pull-request.test.ts packages/github/test/completion-evidence.test.ts packages/control-protocol/src/index.ts packages/client/src/index.ts packages/local-runtime/src/control-v1.ts packages/local-runtime/src/pr.ts packages/local-runtime/src/daemon.ts packages/local-runtime/test/pr.test.ts packages/local-runtime/test/publication-control-v1.test.ts apps/control-plane/src/modules/hosted-runs/permissions.ts apps/control-plane/src/modules/hosted-runs/material-actions.ts apps/control-plane/src/modules/publication-candidates/publisher.ts apps/control-plane/src/modules/publication-candidates/schema.ts apps/control-plane/src/application.ts apps/control-plane/src/runtime.ts apps/control-plane/test/publication.postgres.test.ts apps/control-plane/test/publication-transport.postgres.test.ts apps/control-plane/test/material-actions.postgres.test.ts apps/control-plane/test/material-action-transport.postgres.test.ts
git commit -m "feat: publish draft PRs only after exact approval"
```

## Task 10: Coalesce Slack Status and Controls into One Truthful Thread Projection

**Files:**

- Modify: `packages/core/src/presentation.ts`
- Modify: `packages/dispatcher/src/presentation.ts`
- Modify: `packages/dispatcher/src/source-thread-control.ts`
- Modify: `packages/slack/src/render.ts`
- Modify: `packages/slack/src/source-app.ts`
- Modify: `apps/control-plane/src/modules/provider-delivery/worker.ts`
- Modify: `apps/control-plane/src/application.ts`
- Create: `packages/dispatcher/test/team-relay-presentation.test.ts`
- Create: `packages/slack/test/team-relay-render.test.ts`
- Create: `apps/control-plane/test/source-thread-controls.postgres.test.ts`

**Interfaces:**

- Consumes: canonical Run/Attempt/approval/candidate/publication state and current Provider Delivery Intent state.
- Produces: one semantic Slack status anchor plus authenticated `status`, `cancel`, `approve`, and `reject` control handling.

- [ ] **Step 1: Add failing presentation progression tests**

```ts
expect(render(waitingRun)).toContain("Waiting for your paired Runner");
expect(render(waitingRun)).not.toContain("Working on it");
expect(render(runningRun)).toContain("Running");
expect(render(proposalReadyRun)).toContain("Proposal ready");
```

- [ ] **Step 2: Add stale-control and coalescing tests**

Assert old buttons cannot affect a newer generation, status reads do not extend deadlines, and a terminal summary supersedes undelivered `received`/`running` intents.

- [ ] **Step 3: Add authority tests**

Ordinary member invoke/status, requester/operator cancel, configured Approver publication approval, admin binding, guest denial, and no authority broadening through message text.

- [ ] **Step 4: Implement semantic copy and command routing**

Use closed reason codes; never branch lifecycle logic inside Slack renderers. Provider delivery failure is displayed separately from Run outcome.

- [ ] **Step 5: Run presentation/control suites**

```bash
corepack pnpm vitest run packages/dispatcher/test/team-relay-presentation.test.ts packages/dispatcher/test/source-thread-control.test.ts packages/slack/test/team-relay-render.test.ts apps/control-plane/test/source-thread-controls.postgres.test.ts
```

- [ ] **Step 6: Commit truthful Slack projection**

```bash
git add packages/core/src/presentation.ts packages/dispatcher/src/presentation.ts packages/dispatcher/src/source-thread-control.ts packages/dispatcher/test/team-relay-presentation.test.ts packages/dispatcher/test/source-thread-control.test.ts packages/slack/src/render.ts packages/slack/src/source-app.ts packages/slack/test/team-relay-render.test.ts apps/control-plane/src/modules/provider-delivery/worker.ts apps/control-plane/src/application.ts apps/control-plane/test/source-thread-controls.postgres.test.ts
git commit -m "feat: project current Run truth into Slack"
```

## Task 11: Package `local_direct` and `paired_relay` as Explicit Modes

**Files:**

- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/setup.ts`
- Modify: `packages/cli/src/pair.ts`
- Modify: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/status.ts`
- Modify: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/test/config.test.ts`
- Modify: `packages/cli/test/setup.test.ts`
- Modify: `packages/cli/test/pair.test.ts`
- Modify: `packages/cli/test/start.test.ts`
- Modify: `packages/cli/test/status.test.ts`
- Modify: `packages/cli/test/doctor.test.ts`
- Modify: `deploy/compose/compose.yaml`
- Modify: `deploy/compose/.env.example`
- Modify: `deploy/compose/README.md`
- Modify: `apps/control-plane/Dockerfile`
- Modify: `apps/control-plane/test/deployment-contract.test.ts`
- Modify: `docs/control-plane-deployment.md`

**Interfaces:**

- Consumes: one Control Plane container, PostgreSQL, Slack installation/Secret References, paired Runner identity, GitHub Project Target binding, and one ACP Executor declaration.
- Produces: explicit CLI/config modes, self-host deployment, pairing, status, and doctor output.

- [ ] **Step 1: Add failing mode and truthfulness tests**

```ts
expect(parseConfig({ mode: "local_direct" }).offlineSafe).toBe(false);
expect(parseConfig({ mode: "paired_relay", relayUrl: "https://relay.example" }).executionLocality)
  .toBe("paired_runner");
```

Reject a relay URL that resolves to the same declared local process endpoint when the user requests certified team mode.

- [ ] **Step 2: Add doctor contract tests**

Doctor reports relay reachability/deployment identity, Slack installation, binding digest, Runner credential/generation, readiness, ACP Harness, queue deadline policy, execution isolation, delivery health, and certification state independently.

- [ ] **Step 3: Run CLI/deployment tests and confirm RED**

```bash
corepack pnpm vitest run packages/cli/test apps/control-plane/test/deployment-contract.test.ts
```

- [ ] **Step 4: Implement mode-specific composition**

`local_direct` starts the current local dispatcher/listener/Runner path. `paired_relay` never starts a local team ingress owner; it pairs and runs only the outbound local Runner against the remote self-hosted relay.

- [ ] **Step 5: Keep the deployment Postgres-only and single-node-honest**

Compose includes Control Plane HTTP/jobs and PostgreSQL with health checks, persistent volume, migrations, and backup/restore instructions. It displays `Runner-offline-safe` and `Relay-not-HA`; no Redis/broker/object-store dependency or HA claim is added.

Mount the relay content KEK as a Docker secret and configure only its file reference and immutable version:

```text
OPENTAG_RELAY_CONTENT_KEK_FILE=/run/secrets/opentag_relay_content_kek
OPENTAG_RELAY_CONTENT_KEY_VERSION=v1
```

The setup refuses inline example keys and refuses startup when the key is missing, malformed, or still contains a placeholder. Backup/restore documentation lists the PostgreSQL volume and exact KEK/version together; losing either makes retained ciphertext unrecoverable, while rotating the key without a migration is prohibited in this profile.

- [ ] **Step 6: Run package/build/deployment checks**

```bash
corepack pnpm vitest run packages/cli/test apps/control-plane/test/deployment-contract.test.ts
corepack pnpm --filter @opentag/cli build
corepack pnpm --filter @opentag/control-plane build
corepack pnpm smoke:control-plane-compose:typecheck
```

- [ ] **Step 7: Commit self-host packaging**

```bash
git add packages/cli/src/config.ts packages/cli/src/setup.ts packages/cli/src/pair.ts packages/cli/src/start.ts packages/cli/src/status.ts packages/cli/src/doctor.ts packages/cli/test/config.test.ts packages/cli/test/setup.test.ts packages/cli/test/pair.test.ts packages/cli/test/start.test.ts packages/cli/test/status.test.ts packages/cli/test/doctor.test.ts deploy/compose/compose.yaml deploy/compose/.env.example deploy/compose/README.md apps/control-plane/Dockerfile apps/control-plane/test/deployment-contract.test.ts docs/control-plane-deployment.md
git commit -m "feat: package the self-hosted team relay profile"
```

## Task 12: Certify the Failure Envelope and Replace the Public Product Story

**Files:**

- Create: `apps/control-plane/test/slack-team-profile.e2e.postgres.test.ts`
- Create: `packages/local-runtime/test/paired-relay-recovery.test.ts`
- Create: `scripts/test/team-relay-profile.mjs`
- Create: `scripts/architecture/check-source-app-boundaries.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Replace: `README.md`
- Modify: `README.zh-CN.md`
- Create: `docs/architecture/team-relay.md`
- Create: `docs/testing/team-relay-canary.md`
- Modify: `docs/platforms/slack.en.md`
- Modify: `docs/platforms/slack.zh-CN.md`
- Modify: `docs/design.md`
- Modify: `docs/adr/0001-accepted-progress-attribution.md`
- Modify: `docs/adr/0002-durable-reassessment-obligations.md`
- Modify: `docs/adr/0003-node-postgresql-control-plane.md`
- Modify: `docs/adr/0004-always-on-channel-ingress-local-execution.md`
- Modify: `docs/adr/0005-versioned-source-app-adapter-contract.md`

**Interfaces:**

- Consumes: the complete certified profile and exact deployment identity.
- Produces: deterministic failure evidence, architecture gates, self-host docs, and a truthful public quickstart. Real Slack/GitHub canary execution remains a separately authorized step.

- [ ] **Step 1: Add the deterministic certification matrix**

The production-shaped PostgreSQL suite must prove all of the following:

1. Runner-offline Slack delivery reserves before ACK.
2. Crash before reservation commit produces no ACK permission.
3. Crash after commit/before ACK converges on replay.
4. Crash after ACK/before Admission recovers through the obligation.
5. Duplicate ID/same digest replays; different digest conflicts.
6. Waiting Run expires and cannot be claimed or revived.
7. Claim-versus-expiry and cancel-versus-claim have one winner.
8. Stale fence cannot progress, complete, cancel, or mutate evidence.
9. Safe pre-material interruption may create a new Attempt within the original deadline.
10. Possible material side effect produces `outcome_unknown` and no replacement Attempt.
11. Interrupted workspace is retained and not adopted.
12. Cancellation revokes future authority without claiming side-effect absence.
13. Provider delivery ambiguity reconciles before retry.
14. Terminal truth supersedes stale undelivered presentations.
15. A binding that does not authorize `pull_request` freezes `proposal_only`; it performs no remote write and may terminally project `proposal_ready`.
16. A binding-authorized `pull_request` Run without exact Candidate approval remains nonterminal `running/publication_pending` with `waiting_for_approval`; it performs no remote write and never projects terminal `proposal_ready`.
17. Exact approval permits only the exact Candidate and owned branch.
18. Publication Control V1 exposes no Git/GitHub credential and rejects stale Runner generation, fence, capability replay, wrong step, repository, or head.
19. Crash after remote push/PR commit but before response reconciles the original operation before any retry.
20. Ambiguous push/PR remains `outcome_unknown` without blind replay.
21. Exact PR/head/check evidence is required for `pull_request_ready`.
22. Relay and Runner restart do not duplicate Run, Attempt, delivery, or PR.
23. Context is bounded to 20 messages/64 KiB and attachment metadata only.
24. Source deletion versus claim/read/running Attempt has one fenced coordinator outcome and releases no new authority after the deletion winner.
25. Terminal purge removes readable content while tombstone still blocks replay.
26. Guest and ordinary member cannot gain material authority.
27. Provider delivery result never changes Run result.

- [ ] **Step 2: Implement the architecture boundary check**

Reject imports of hosted-runs, Runner, store repository implementation, governance evaluator implementation, or another provider package from any Source App package. Allow core/delivery/client contracts, `@opentag/source-app-runtime`, provider SDKs, transport libraries, and typed helper modules. Parse the Control Plane's production dependency graph and fail if it contains `@opentag/dispatcher`, `@opentag/store`, `better-sqlite3`, SQLite Drizzle adapters, or any non-Slack Source App package. Parse `@opentag/source-app-runtime` and `@opentag/delivery-runtime` manifests and fail if they depend on database, HTTP-framework, Provider, or application packages.

- [ ] **Step 3: Add root scripts and CI order**

```json
{
  "check:source-apps": "node scripts/architecture/check-source-app-boundaries.mjs",
  "test:team-relay": "vitest run apps/control-plane/test/slack-team-profile.e2e.postgres.test.ts packages/local-runtime/test/paired-relay-recovery.test.ts",
  "smoke:team-relay": "node scripts/test/team-relay-profile.mjs"
}
```

CI order is frozen install, source-app boundary check, build, typecheck, lint, unit/integration tests, team-relay certification, and Compose smoke.

- [ ] **Step 4: Rewrite the public story around the product journey**

The first screen says, in product-native language:

```text
Mention any coding agent. Get proof, not promises.

Run OpenTag's relay on infrastructure you choose, pair one local Runner,
and turn a Slack engineering thread into governed local agent work with
verifiable results.
```

Document `local_direct` as a trial and `paired_relay` as the certified team profile. Do not mention competitor inspiration, managed-service availability, HA, production activation, or unsupported Source Apps.

- [ ] **Step 5: Write the separately authorized real-canary runbook**

The runbook requires a real Slack App, one private engineering channel, one GitHub test repository, one self-hosted relay deployment, one paired local Runner, and one ACP Harness. It records exact relay head/config/binding/Runner generation, source thread, Run/Attempt/fence, candidate digest, and optional exact-approved draft PR/head/check receipts. It performs no real provider action without explicit authorization.

- [ ] **Step 6: Run the complete deterministic gate**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:source-apps
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:team-relay
corepack pnpm smoke:control-plane-compose:typecheck
git diff --check
```

- [ ] **Step 7: Confirm no destructive reset or managed-service claim remains**

```bash
rg -n "managed relay is available|production activated|relay is highly available|auto-merge|ambient memory|scheduled work" README.md README.zh-CN.md docs packages apps
```

Expected: no affirmative product claim; historical/negative references must be visibly marked as deferred, unsupported, or superseded.

- [ ] **Step 8: Commit the certification and product reset**

```bash
git add apps/control-plane/test/slack-team-profile.e2e.postgres.test.ts packages/local-runtime/test/paired-relay-recovery.test.ts scripts/test/team-relay-profile.mjs scripts/architecture/check-source-app-boundaries.mjs package.json .github/workflows/ci.yml README.md README.zh-CN.md docs/architecture/team-relay.md docs/testing/team-relay-canary.md docs/platforms/slack.en.md docs/platforms/slack.zh-CN.md docs/design.md docs/adr/0001-accepted-progress-attribution.md docs/adr/0002-durable-reassessment-obligations.md docs/adr/0003-node-postgresql-control-plane.md docs/adr/0004-always-on-channel-ingress-local-execution.md docs/adr/0005-versioned-source-app-adapter-contract.md
git commit -m "docs!: certify the self-hosted OpenTag team relay"
```

---

## Merge Gate

This branch is merge-ready only when:

- The old destructive reset is visibly superseded and none of its deletion tasks ran.
- Slack is registered through the typed Source App contract and no canonical lifecycle code imports Slack types.
- A verified Slack delivery commits Reservation + Processing Obligation before ACK.
- The self-hosted relay admits while the paired Runner is offline and displays a finite immutable claim deadline.
- Placement/claim revalidates current Runner, target, capability, credential generation, and capacity.
- Claim, expiry, cancel, and stale-fence races are deterministic under PostgreSQL.
- Runner interruption, workspace preservation, safe retry, and `outcome_unknown` follow the accepted rules.
- Provider delivery is independently journaled, reconciled, coalesced, and deadline-bounded.
- Default completion is verified `proposal_ready`; Executor success alone is insufficient.
- Draft PR creation requires binding authorization plus exact approval and authoritative receipts.
- No code path auto-merges, force-pushes, writes the target branch, rebases, deletes a remote branch, or adopts an unknown branch.
- `local_direct` and `paired_relay` have distinct runtime composition and truthful status.
- The single-node self-hosted relay displays `Runner-offline-safe` and `Relay-not-HA`.
- Context, attachment, retention, deletion, membership, requester, operator, and Approver boundaries pass deterministic tests.
- The full local deterministic gate passes from a clean checkout.
- No publish, push, production deploy, managed relay activation, or real provider canary is claimed without separate evidence and authorization.

## Stop Conditions

Stop and redesign the active task if:

- A Source App package begins owning Admission, Run, Attempt, retry, approval, completion, or terminal state.
- Control Plane adds a second provider-delivery retry kernel instead of a PostgreSQL repository for the existing kernel.
- Runner presence/heartbeat is used as proof of execution, completion, or relay availability.
- A same-machine relay is presented as team/offline-safe mode.
- A deadline, lease, approval, or cancelled Run is renewed or revived by reconnect, status, configuration, or operator recovery.
- A stale workspace is adopted, cleaned, reset, stashed, or deleted automatically.
- An ambiguous external write is retried before exact reconciliation.
- Slack delivery success is used to change Run outcome, or Run outcome is used to claim Slack delivery.
- Executor success alone satisfies completion.
- Source text grants authority beyond the frozen binding policy.
- Managed relay, ambient memory, schedules, attachment-body custody, second ingress, multi-Runner fallback, or auto-merge enters this plan.
- A failure test requires a real provider credential when a deterministic fixture can prove the contract.
