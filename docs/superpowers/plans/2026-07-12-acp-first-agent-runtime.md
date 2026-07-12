# ACP-First Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task, with a fresh implementer and reviewer for each task.

**Goal:** Replace OpenTag's unshipped custom executor JSONL protocol with a generic ACP host, make durable runs recoverable through fenced attempts, and expose one small channel-facing contract that preserves the existing Slack/Lark source-thread experience.

**Architecture:** OpenTag remains the durable control plane. A `Run` is durable user intent; every execution lease creates an immutable `Attempt` with a fencing token; an ACP session is disposable runtime state owned by that attempt. Existing channel adapters, approval records, action receipts, and provider renderers remain the implementation seams. The runner gains a generic stdio ACP client, while integration manifests only declare discovery metadata and role bindings.

**Tech Stack:** TypeScript, Zod, SQLite/Drizzle, `@agentclientprotocol/sdk` 1.2.1, Vitest, pnpm workspaces.

## Global Constraints

- Do not preserve compatibility with `opentag.executor.v1`, `stdio-jsonl-basic`, or the custom executor event schema; they have not shipped.
- Do not put raw credentials in run records, manifests, ACP prompts, MCP payloads, logs, audit events, or test snapshots.
- Preserve existing Slack/Lark/GitHub/Linear/Telegram behavior unless a task explicitly changes a shared contract.
- Reuse the existing approval, apply-plan, suggested-change, callback-receipt, and presentation paths instead of creating parallel governance systems.
- Keep the implementation a modular monolith plus the existing independent local worker/daemon.
- Run package-local tests after each task. Run repository build, lint, typecheck, and test sequentially at the end.
- Every commit must follow the repository Lore commit protocol and record verification evidence.

---

## Task 1: Replace the experimental integration manifest vocabulary

**Files:**

- Modify: `packages/core/src/integration-protocol.ts`
- Add: `packages/core/src/channel-protocol.ts`
- Modify: `packages/core/src/index.ts`
- Add: `packages/core/test/integration-protocol.test.ts`
- Add: `packages/core/test/channel-protocol.test.ts`
- Delete: `packages/core/src/executor-protocol.ts`
- Delete: `packages/core/test/executor-protocol.test.ts`
- Modify: `packages/core/src/json-schema.ts` only if its exports reference removed schemas

**Contract:**

- Keep `protocol: "opentag.integration.v1"` as the manifest envelope.
- Replace the binding union with an ACP stdio binding:

  ```ts
  {
    kind: "stdio";
    command: string;
    args?: string[];
    cwd?: string;
  }
  ```

- Replace `roles.executor` with `roles.agent`:

  ```ts
  {
    protocol: "agent-client-protocol";
    protocolVersion: 1;
    binding: string;
  }
  ```

- Add an optional `roles.channel` declaration using `opentag.channel.v1`. The manifest role only declares its binding and managed/exclusive ownership metadata; it does not execute agent work.
- Keep resources extensible with `z.record(OpenTagResourceCapabilitySchema)` so OpenTag is not repository-bound.
- Add `opentag.channel.v1` schemas for normalized inbound messages, outbound Run Card updates, approval prompts, and action receipts. The contract must use provider-neutral refs and must not contain Slack- or Lark-specific payloads.
- Move `selectReplyTargetsForPurpose` tests out of the deleted executor-protocol test and keep them passing.

**TDD sequence:**

1. Write manifest tests that accept an ACP stdio agent and reject missing bindings, relative/blank commands, unknown legacy executor fields, and `opentag.executor.v1`.
2. Write channel tests that parse a normalized inbound source-thread message and the four outbound message kinds.
3. Run `corepack pnpm vitest run packages/core/test/integration-protocol.test.ts packages/core/test/channel-protocol.test.ts` and confirm the new tests fail against the old implementation.
4. Implement the schemas, exports, and deletion.
5. Re-run the targeted tests and `corepack pnpm --filter @opentag/core build`.

**Commit intent:** `Adopt ACP and a provider-neutral channel role before integrations ship`

---

## Task 2: Add durable attempts and fencing to the run lease lifecycle

**Files:**

- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/json-schema.ts`
- Modify: `packages/store/src/schema.ts`
- Modify: `packages/store/src/repository.ts`
- Modify: `packages/store/src/index.ts`
- Modify: `packages/store/test/repository.test.ts`
- Modify: `packages/dispatcher/src/server.ts`
- Modify: `packages/client/src/index.ts`
- Add or modify targeted dispatcher/client tests that cover claim, heartbeat, start, progress, completion, and cancellation

**Contract:**

- Add schemas/types for `ConnectionRef`, `Attempt`, `Grant`, `Action`, `ActionReceipt`, `Artifact`, and verification evidence. Use opaque reference IDs; never persist secret values.
- Add an `attempts` table with at least: `id`, `runId`, `number`, `runnerId`, `fencingToken`, `status`, `startedAt`, `heartbeatAt`, `leaseExpiresAt`, `finishedAt`, `resultJson`, timestamps, and a unique `(runId, number)` constraint.
- Add a current attempt pointer to `runs` or derive it transactionally. `claimNextRun` must atomically create a new attempt and return `attemptId` plus `fencingToken`.
- Every mutating runner operation (`markRunning`, `heartbeat`, progress append, `completeRun`) must require and compare the active attempt ID and fencing token. A stale worker receives a deterministic conflict and cannot publish progress or complete the run.
- Lease expiry marks the active attempt interrupted before requeueing the run. A newly claimed run creates a new attempt with a new token.
- Keep the current public run status vocabulary for this task to avoid rewriting all presentation code; the durable distinction lives in attempt records and events.
- Extend claimed-run client types and daemon client methods with the attempt lease token. Do not log the token.

**TDD sequence:**

1. Add a store regression test: claim run -> expire/requeue -> claim again -> old attempt heartbeat/progress/completion are rejected -> new attempt completes exactly once.
2. Add a duplicate completion/idempotency test for the same active attempt.
3. Run the targeted store and dispatcher/client tests and confirm they fail.
4. Implement schema migration, repository transaction checks, HTTP request schemas, and client forwarding.
5. Re-run targeted tests, then `corepack pnpm --filter @opentag/store build`, `corepack pnpm --filter @opentag/client build`, and `corepack pnpm --filter @opentag/dispatcher build` sequentially.

**Commit intent:** `Prevent stale workers from mutating durable runs after lease recovery`

---

## Task 3: Implement the generic stdio ACP host and delete the custom runner protocol

**Files:**

- Modify: `packages/runner/package.json`
- Modify: `pnpm-lock.yaml`
- Add: `packages/runner/src/acp-executor.ts`
- Modify: `packages/runner/src/executor.ts`
- Modify: `packages/runner/src/index.ts`
- Add: `packages/runner/test/acp-executor.test.ts`
- Add: `packages/runner/test/fixtures/acp-agent.mjs`
- Delete: `packages/runner/src/protocol-executor.ts`
- Delete: `packages/runner/test/protocol-executor.test.ts`
- Delete: every `packages/runner/test/fixtures/protocol-shim*.mjs` file

**Contract:**

- Depend on the official `@agentclientprotocol/sdk` package at `^1.2.1`.
- `createAcpExecutor` consumes the normalized manifest agent role and stdio binding, spawns the configured child with scrubbed environment, and speaks ACP over NDJSON stdio.
- Initialize protocol version 1, create a session with an absolute `cwd`, pass `mcpServers: []` by default, and submit an OpenTag-built prompt containing command, selected context, exclusions, and non-secret permission scope labels.
- Normalize ACP agent-message chunks, tool calls/updates, plans, and stop responses into the existing `ExecutorEventSink` plus `OpenTagRunResult`. Do not copy raw ACP frames to channel-facing progress.
- Support cancellation by sending ACP session cancel and then terminating the child after a bounded grace period.
- Surface `session/request_permission` through an injected permission resolver. Map ACP options to OpenTag decisions without automatically selecting an allow option.
- Preserve OpenTag-owned git isolation for repository runs. For scratch runs, execute in the supplied absolute scratch directory and skip git branch/commit operations.
- Ensure child exit, malformed messages, protocol errors, cancellation, and refusal produce deterministic results/errors and always clean up the subprocess.

**TDD sequence:**

1. Build a fixture ACP agent with the official SDK that emits text/tool updates, requests permission, returns a stop reason, and observes cancellation.
2. Add tests for successful streamed execution, permission allow once, permission deny, cancellation, malformed child exit, repository worktree use, and scratch cwd use.
3. Run `corepack pnpm vitest run packages/runner/test/acp-executor.test.ts` and confirm failure before implementation.
4. Add the dependency and implement the adapter; remove the legacy files and exports.
5. Re-run the runner tests and `corepack pnpm --filter @opentag/runner build`.

**Commit intent:** `Let any ACP agent execute as a disposable OpenTag attempt`

---

## Task 4: Wire ACP execution into the daemon and allow non-repository runs

**Files:**

- Modify: `packages/local-runtime/src/config.ts`
- Modify: `packages/local-runtime/src/runtime.ts`
- Modify: `packages/local-runtime/src/daemon.ts`
- Modify: `packages/local-runtime/src/dispatcher.ts`
- Modify: `packages/local-runtime/test/daemon.test.ts`
- Add: `packages/local-runtime/test/acp-daemon.test.ts`
- Modify: `packages/store/src/repository.ts`
- Modify: `packages/store/src/schema.ts` if channel bindings still require repository columns
- Modify: affected setup/config docs and example configuration

**Contract:**

- Runtime configuration supports named ACP agents backed by integration manifests. Include a Hermes example profile using command `hermes` and args `acp`; do not special-case Hermes in the ACP host.
- A run may be claimed without a Project Target. Repository-targeted runs still require an allowlisted local binding; non-repository runs receive a newly created absolute scratch directory under the configured OpenTag runtime root.
- Change `ExecutorRunInput` so workspace intent is explicit (`repository` with checkout metadata or `scratch` with absolute path), rather than pretending every run has a repository checkout.
- Keep source-thread mutation commands on the existing governed apply path.
- Thread `attemptId` and fencing token through mark-running, heartbeat, progress, completion, and cancellation.
- Clean scratch directories according to the same retention policy as worktrees.
- Remove repository `NOT NULL` assumptions from generic channel bindings while keeping repository-specific binding validation when repo fields are present.

**TDD sequence:**

1. Add daemon tests for one repository ACP task, one ordinary scratch ACP task, missing repository allowlist rejection, and stale-attempt cancellation.
2. Add store tests proving a non-repository event can be claimed by an eligible runner.
3. Run targeted tests and confirm failure.
4. Implement configuration, workspace resolution, scratch lifecycle, and token threading.
5. Re-run targeted tests and build `@opentag/local-runtime`.

**Commit intent:** `Make ACP agents useful beyond repository-bound coding tasks`

---

## Task 5: Connect ACP permission requests to OpenTag grants and material actions

**Files:**

- Modify: `packages/core/src/action.ts`
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/store/src/schema.ts`
- Modify: `packages/store/src/repository.ts`
- Modify: `packages/dispatcher/src/server.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/local-runtime/src/daemon.ts`
- Modify: `packages/runner/src/acp-executor.ts`
- Add or modify focused tests in core, store, dispatcher, client, local-runtime, and runner

**Contract:**

- Approval modes are `ask`, `auto`, and `autonomous`; default is `auto`.
- User decisions are `allow_once`, `allow_run`, and `deny`. `allow_once` is attempt-bound; `allow_run` is run-bound and may only match the normalized action family/scope approved; deny does not grant anything.
- The ACP host pauses a permission request until the dispatcher resolves it or the attempt is cancelled/expired. Existing source-thread approval presentation and callback handling must carry the decision back to the waiting attempt.
- Material actions (including push, deploy, publish, issue mutations, and connector writes) get a stable action ID and idempotency key before execution. Store status, normalized target, risk tier, decision snapshot hash, attempt fencing token, timestamps, and provider receipt reference; never store credentials.
- Retries must reconcile by action ID/idempotency key. A known success returns the stored receipt; a known failure may retry only when policy permits; an unknown result stops automatic retries and requires human resolution.
- Keep internal safety guardrails even when the user chooses no custom limit or autonomous mode.

**TDD sequence:**

1. Add policy tests for ask/auto/autonomous and allow-once/allow-run/deny matching.
2. Add an integration test: ACP requests a material action -> run enters approval wait -> allow once -> action executes once -> receipt is delivered -> duplicate request reuses the receipt.
3. Add crash-window tests for known-success and unknown provider outcomes.
4. Run targeted tests and confirm failure.
5. Implement by extending the existing approval/apply receipt path; do not create a second callback subsystem.
6. Re-run targeted tests and affected package builds.

**Commit intent:** `Give ACP agents governed power without hiding material side effects`

---

## Task 6: Unify Slack/Lark delivery behind the channel contract and Balanced Run Card

**Files:**

- Modify: `packages/core/src/presentation.ts`
- Modify: `packages/dispatcher/src/presentation.ts`
- Modify: `packages/dispatcher/src/server.ts`
- Modify: `packages/slack/src/index.ts` and focused Slack renderer tests
- Modify: `packages/lark/src/index.ts` and focused Lark renderer tests
- Modify: channel-binding setup/config code and tests
- Modify: `docs/acp-first-agent-runtime-design.md` only for implementation-discovered corrections
- Modify: `docs/integration-taxonomy.md`
- Delete or replace: `docs/executor-protocol.md`
- Modify: `docs/configuration.md`
- Add: `docs/acp-agent-integration.md`

**Contract:**

- Existing native Slack and Lark adapters implement `opentag.channel.v1` normalization/rendering at their current seams; do not proxy Slack through Lark or require cross-channel collaboration.
- A managed channel binding is exclusive for the configured bot/application identity and fails closed when ownership cannot be verified. Bot display names remain provider/application configuration, not protocol identity.
- Default channel UX is Balanced: one source-thread Run Card is updated at lifecycle milestones; routine tool chatter is audit-only; approvals, blockers, material action receipts, and final summaries are visible.
- Raw ACP frames, hidden reasoning, credentials, and fencing tokens never appear in channel messages.
- Setup stays four conceptual choices: Channel, Agent, Connections, Mode. Default mode is Auto and custom user limits are absent until configured.
- The Hermes example uses two independent identities/configurations when it plays both channel gateway and ACP agent; role credentials and lifecycle remain separate.

**TDD sequence:**

1. Add provider-parity tests showing the same normalized queued/running/approval/action/final inputs render correctly in Slack and Lark.
2. Add delivery-noise tests proving audit-only ACP tool updates do not emit source-thread callbacks, while blockers and material actions do.
3. Add managed-binding tests for exclusive ownership and fail-closed mismatch.
4. Run targeted tests and confirm failure.
5. Implement the smallest renderer/binding changes and update documentation.
6. Re-run all affected package tests.

**Commit intent:** `Keep ACP execution quiet and legible in existing source threads`

---

## Final Verification

Run these commands sequentially from the repository root:

```bash
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke:governance
corepack pnpm smoke:privacy
```

Then verify removal and coverage:

```bash
rg -n 'opentag\.executor\.v1|stdio-jsonl-basic|OpenTagExecutorProtocol|createProtocolExecutor' packages docs
git status --short
git log --oneline --decorate -8
```

The legacy search must return no production/test references. Documentation may mention the removed names only in an explicit migration/removal note, not as a supported contract.

## Acceptance Demonstration

The final branch must contain automated evidence for all four scenarios:

1. One ordinary non-repository task completes in a scratch workspace through ACP.
2. One repository task completes through ACP in OpenTag-owned isolation.
3. One material external action is approved, executed once, and reconciled by receipt.
4. A worker crash/lease expiry creates a new attempt and the stale attempt cannot duplicate progress, completion, or the material action.

It must also demonstrate that a second ACP fixture/agent manifest works without changing channel adapter code.
