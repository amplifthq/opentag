# OpenTag Design

## Status

Implementation-ready draft, 2026-06-24

## One-Liner

OpenTag is the open mention layer for agents: tag any approved agent from a workspace surface, route the request through scoped permissions and auditable context, and let a local or hosted runner execute the work and report back.

## Why Now

Claude Tag makes agent mentions feel natural inside team collaboration tools. The opportunity for OpenTag is to turn that interaction pattern into an open, vendor-neutral layer:

- Claude Tag brings Claude into Slack.
- OpenTag brings any agent into any workspace.
- Claude Tag is one model, one vendor, one collaboration surface first.
- OpenTag should be protocol-first, executor-neutral, and local-runner friendly.

The first release should move fast enough to ride the conversation while still proving the idea with a real end-to-end task flow.

## Product Goal

OpenTag should let a person write something like:

```text
@opentag fix this flaky test
```

from GitHub, Slack, Lark, or a similar workspace surface, then have OpenTag:

1. Recognize the tagged agent request.
2. Normalize the workspace event into a stable OpenTag event.
3. Check actor, target, context, and permission scope.
4. Create a run with auditable state.
5. Dispatch the run to an approved local or hosted executor.
6. Stream progress and final output back to the original surface.

## First Release Scope

The first release combines a fast open-source launch with one real MVP:

- A public repository with a clear README, design document, and protocol draft.
- A GitHub App MVP powered by Probot at the edge.
- An extremely thin hosted dispatcher for public webhook ingress, run persistence, runner lease claiming, and callback coordination.
- A local runner daemon that can receive or poll for OpenTag runs.
- At least one executor adapter for a coding agent, initially Codex, Claude Code, or oh-my-pi.
- A callback adapter that posts status and final results back to GitHub.

The first release should not attempt to support every workspace, every agent, every permission model, or every deployment shape.

## Non-Goals For V0

- No full Slack or Lark app in the first implementation milestone.
- No custom hosted IDE or chat UI.
- No general-purpose agent framework.
- No dependency on a single executor framework.
- No broad multi-tenant SaaS control plane until the local GitHub flow proves demand.
- No Rust requirement for v0. Keep the default implementation in TypeScript unless packaging, security, or performance constraints prove otherwise.
- No autonomous background execution without an explicit mention, command, or approval boundary.

## Core Product Principles

- Open core, closed surfaces optional: the protocol and local runner path should be usable without depending on a hosted SaaS.
- Protocol at the center: GitHub, Slack, Lark, and future surfaces are adapters, not the architecture.
- Local-first execution: the runner can live on the user's machine so repo access, credentials, build tools, and private context stay local.
- Auditable by default: every run records who asked, what context was provided, what permissions were granted, which executor ran, and where the result was posted.
- Small reversible permissions: each tagged run receives a narrow grant instead of inheriting broad ambient authority.
- Adapter neutrality: Codex, Claude Code, oh-my-pi, Mastra workflows, and custom agents should all be possible executors.

## System Shape

```text
Workspace Surface
  GitHub issue comment / PR comment
        |
        v
GitHub Ingress App
  Probot webhook handler
        |
        v
OpenTag Core
  event normalization
  target parsing
  policy check
  run creation
        |
        v
Dispatch Layer
  thin hosted dispatcher
  run queue, leases, audit events, callbacks
        |
        v
OpenTag Local Daemon
  workspace checkout access
  executor adapter
  progress streaming
        |
        v
Executor
  Codex / Claude Code / oh-my-pi / custom
        |
        v
Callback Adapter
  GitHub status comment / PR / summary
```

## Package Boundaries

Suggested repository layout:

```text
packages/opentag-core
packages/opentag-github
packages/opentag-runner
packages/opentag-store
apps/github-probot
apps/dispatcher
apps/opentagd
examples/github-to-codex
examples/github-to-omp
docs/
```

### `packages/opentag-core`

Owns the stable OpenTag domain model. It must not import Probot, Octokit, Slack SDKs, Lark SDKs, or executor-specific packages.

Responsibilities:

- `OpenTagEvent` types.
- `OpenTagRun` lifecycle.
- target parsing rules.
- permission grant model.
- callback route model.
- run status vocabulary.
- serialization and validation.

### `packages/opentag-github`

Owns GitHub-specific translation and callback behavior.

Responsibilities:

- convert GitHub webhook payloads into `OpenTagEvent`.
- map repository, issue, PR, branch, and comment context.
- post status comments.
- optionally open branches or PRs in later milestones.

### `apps/github-probot`

Owns the Probot GitHub App edge.

Responsibilities:

- receive GitHub webhooks.
- validate installation and event type.
- detect `@opentag` mentions.
- call `packages/opentag-github` and `packages/opentag-core`.
- enqueue a run for the dispatcher.

Probot is intentionally an edge dependency only. If future deployment requires Octokit directly, Cloudflare Workers, or a different webhook server, this app can be replaced without changing the core protocol.

### `apps/dispatcher`

Owns the extremely thin hosted control plane.

Responsibilities:

- accept normalized OpenTag events from ingress apps.
- persist runs and audit events.
- expose runner pairing and polling endpoints.
- implement lease-based run claiming.
- receive runner status updates.
- coordinate callback delivery through provider adapters.

The dispatcher should stay boring. It is not an agent runtime, workflow engine, hosted IDE, or chat product. Its job is to bridge public workspace events to private/local runners without requiring the user's machine to expose an inbound port.

### `packages/opentag-store`

Owns persistence schemas and repository-style accessors.

Responsibilities:

- run storage.
- audit event storage.
- runner registration storage.
- repository-to-runner binding storage.
- lease claiming primitives.

The v0 store can be SQLite or libSQL with a simple state machine. Avoid Redis, Temporal, Trigger.dev, Inngest, or other durable workflow platforms until the run lifecycle proves it needs them.

### `apps/opentagd`

Owns the local daemon.

Responsibilities:

- authenticate with the dispatcher.
- poll or receive assigned runs.
- resolve local workspace paths.
- start executor adapters.
- stream logs, status, and final artifacts.
- report completion or failure.

The local daemon is the main product differentiator. It lets OpenTag work with existing local coding environments instead of forcing all execution into a hosted black box.

### `packages/opentag-runner`

Owns executor-neutral runner contracts and common lifecycle handling.

Responsibilities:

- executor adapter interface.
- process spawning contract.
- timeout and cancellation.
- status normalization.
- artifact and patch reporting.
- structured final result.

## Core Data Model

### OpenTag Event

```ts
type OpenTagEvent = {
  id: string;
  source: "github" | "slack" | "lark" | "cli" | "webhook";
  sourceEventId: string;
  receivedAt: string;
  actor: ActorIdentity;
  target: AgentTarget;
  command: OpenTagCommand;
  context: ContextPointer[];
  permissions: PermissionGrant[];
  callback: CallbackRoute;
  metadata: Record<string, unknown>;
};
```

### Actor Identity

```ts
type ActorIdentity = {
  provider: "github" | "slack" | "lark";
  providerUserId: string;
  handle?: string;
  displayName?: string;
  organizationId?: string;
};
```

### Agent Target

```ts
type AgentTarget = {
  mention: string;
  agentId: string;
  executorHint?: "codex" | "claude-code" | "oh-my-pi" | "custom";
  workspaceHint?: string;
};
```

### Command

```ts
type OpenTagCommand = {
  rawText: string;
  intent: "fix" | "review" | "investigate" | "explain" | "run" | "unknown";
  args: Record<string, string | boolean | number>;
};
```

### Context Pointer

```ts
type ContextPointer = {
  kind:
    | "github.repo"
    | "github.issue"
    | "github.pull_request"
    | "github.comment"
    | "github.commit"
    | "file"
    | "url"
    | "text";
  uri: string;
  title?: string;
  visibility: "public" | "private" | "organization";
};
```

### Permission Grant

```ts
type PermissionGrant = {
  scope:
    | "repo:read"
    | "repo:write"
    | "issue:comment"
    | "pr:create"
    | "pr:update"
    | "runner:local"
    | "network:restricted";
  reason: string;
  expiresAt?: string;
};
```

### Callback Route

```ts
type CallbackRoute = {
  provider: "github" | "slack" | "lark" | "webhook";
  uri: string;
  threadKey?: string;
};
```

### Run

```ts
type OpenTagRun = {
  id: string;
  eventId: string;
  status:
    | "queued"
    | "assigned"
    | "running"
    | "needs_approval"
    | "succeeded"
    | "failed"
    | "cancelled";
  assignedRunnerId?: string;
  executor?: string;
  createdAt: string;
  updatedAt: string;
  result?: OpenTagRunResult;
};
```

## Hosted Dispatcher

The v0 hosted dispatcher exists because GitHub webhooks need a public endpoint while the executor should remain local-first. It should be as small as possible:

- receive normalized events from `apps/github-probot`.
- create and persist `OpenTagRun` records.
- let paired local daemons poll for eligible runs.
- lease a run to exactly one daemon at a time.
- accept status/result updates from the daemon.
- call provider callback adapters to post acknowledgements, progress, and final results.

The dispatcher should not inspect local files, hold repository credentials beyond what the GitHub App needs for callbacks, execute agent code, or own workspace-specific business logic.

### V0 Run State Machine

```text
queued
  -> assigned
  -> running
  -> needs_approval
  -> succeeded
  -> failed
  -> cancelled
```

Lease fields should be explicit:

```ts
type RunLease = {
  runId: string;
  runnerId: string;
  leasedAt: string;
  leaseExpiresAt: string;
  heartbeatAt?: string;
};
```

If a lease expires, the dispatcher can move the run back to `queued` or mark it `failed` depending on retry policy.

### V0 Storage

Start with four tables:

- `runs`: current run state and normalized event snapshot.
- `run_events`: append-only audit events.
- `runners`: registered local daemon identities.
- `repo_bindings`: provider repo to runner/workspace mapping.

This is enough for a real demo without introducing a workflow platform.

## GitHub MVP Flow

### Trigger

The v0 trigger is an issue or pull request comment:

```text
@opentag fix this
@opentag review this PR
@opentag investigate the failing test
```

### Ingress

`apps/github-probot` listens for:

- `issue_comment.created`
- `pull_request_review_comment.created`

The handler ignores events without a configured OpenTag mention.

### Normalization

The GitHub adapter extracts:

- repository owner/name.
- issue or pull request number.
- comment URL and body.
- actor login and ID.
- installation ID.
- callback location.

It creates an `OpenTagEvent` and stores or enqueues it.

### Runner Assignment

For v0, runner assignment can be simple:

- a single local daemon is paired with a single GitHub installation or repo.
- the daemon polls for eligible runs.
- the dispatcher returns one queued run at a time.
- the daemon claims the run before execution.

### Execution

The local daemon:

1. Finds the configured local checkout.
2. Creates an isolated worktree or branch for the run.
3. Starts the selected executor with a bounded prompt.
4. Streams status back to OpenTag.
5. Produces a structured final result.

### Callback

The GitHub callback adapter posts:

- initial acknowledgement: "OpenTag picked this up."
- progress checkpoints for long runs.
- final success/failure summary.
- optional PR link when the executor creates a change.

## Executor Adapter Contract

An executor adapter should hide tool-specific process details behind one interface:

```ts
type ExecutorAdapter = {
  id: string;
  displayName: string;
  canRun(input: ExecutorRunInput): Promise<ExecutorReadiness>;
  run(input: ExecutorRunInput, sink: ExecutorEventSink): Promise<ExecutorRunResult>;
  cancel(runId: string): Promise<void>;
};
```

The first executor adapter can be intentionally narrow. For example:

- run a command-line coding agent in a local checkout.
- pass the normalized task prompt and context.
- capture stdout/stderr and final summary.
- report whether files changed.

The adapter should not decide OpenTag permissions. It receives an already-authorized run and reports what it did.

## Framework Choices

### TypeScript As The Default Stack

Use TypeScript across the v0 repository: Probot app, dispatcher, protocol schemas, runner contracts, CLI, and local daemon.

Reasons:

- GitHub, Slack, Lark, Probot, Octokit, and most agent SDK ecosystems are already TypeScript-friendly.
- One type system can cover the protocol, adapters, dispatcher, and daemon.
- Zod or a similar schema library can validate runtime payloads and export public JSON Schema.
- A TypeScript daemon is easier to iterate while the runner contract is still changing.

### Rust Deferred For V0

Do not choose Rust as a default implementation language for v0.

Rust may become useful later for:

- a hardened local daemon with stronger process isolation.
- native packaging and auto-update flows.
- high-volume log streaming or patch processing.
- a security-sensitive sandbox boundary.

For the first release, Rust adds cross-language build complexity before the architecture has proven the tag-to-run loop. Keep Rust as a future local-runtime optimization, not a product prerequisite.

### Probot For GitHub V0

Use Probot for the first GitHub App because it is the fastest way to receive GitHub App webhooks and call GitHub APIs from Node.js.

Constraint:

- Probot must stay at the edge. No Probot types in `opentag-core`.

Rejected alternative:

- Direct Octokit for v0. Octokit gives more control and may be better for a future custom edge gateway, but it requires more webhook and app-auth wiring before OpenTag has proven the core flow.

### Mastra As Optional Orchestrator

Mastra can be useful for workflows, agent abstractions, memory, observability, and model routing, but it should not define the OpenTag protocol.

V0 should only introduce Mastra if it materially reduces implementation time for run orchestration. Otherwise, a lightweight TypeScript orchestrator is preferable until the domain model stabilizes.

### Agent-Native As Design Inspiration

Builder.io Agent Native is useful as a reference for shared actions and app-native agent interactions. OpenTag can borrow the idea that actions should be reusable across UI, HTTP, MCP, CLI, and agents.

Do not make Agent Native a required dependency for v0.

### Eve As Cloud Demo Option

Vercel Eve could accelerate a Slack-flavored cloud demo, especially for teams already on Vercel. It should be treated as an optional adapter path, not the core.

### oh-my-pi As Executor Adapter

oh-my-pi is best treated as an executor target. OpenTag can route a run to oh-my-pi, but OpenTag should not become an oh-my-pi remote-control wrapper.

## Permissions And Trust

OpenTag needs explicit trust boundaries because mentions can look casual while execution may be powerful.

V0 policy:

- Only configured repositories can trigger runs.
- Only configured actors or teams can invoke write-capable tasks.
- Every event gets an explicit permission grant list.
- Local runner pairing is explicit.
- The runner should reject runs outside configured workspace paths.
- Dangerous operations require either local confirmation or a future approval state.

Important future policy questions:

- Should `@opentag fix` be allowed to push directly, or only open a PR?
- Should a reviewer approval be required before write operations?
- Should organization admins define agent allowlists centrally?
- How should local secrets be protected from prompt-injected repo content?

## Audit Log

Each run should preserve:

- original source event ID and URL.
- actor identity.
- normalized command.
- context pointers.
- permission grants.
- assigned runner.
- executor adapter.
- start/end timestamps.
- status transitions.
- callback messages posted.
- artifact or PR links.

The audit log is part of the product, not an implementation detail. It is how OpenTag earns trust as an open alternative to opaque chat-agent execution.

## Local Runner Pairing

The initial pairing model can be simple:

1. User installs `opentagd`.
2. User logs in or registers the daemon with a pairing token.
3. User maps a GitHub repo to a local checkout path.
4. User selects a default executor adapter.
5. The daemon starts polling for assigned runs.

Example config:

```json
{
  "runnerId": "runner_local_mingyoo_macbook",
  "repositories": [
    {
      "provider": "github",
      "owner": "example",
      "repo": "demo",
      "checkoutPath": "/Users/mingyoo/repos/demo",
      "defaultExecutor": "codex"
    }
  ]
}
```

## Result Model

The final result should be structured so each surface can render it consistently:

```ts
type OpenTagRunResult = {
  conclusion: "success" | "failure" | "cancelled" | "needs_human";
  summary: string;
  changedFiles?: string[];
  createdPullRequestUrl?: string;
  artifacts?: { title: string; uri: string }[];
  verification?: {
    command: string;
    outcome: "passed" | "failed" | "not_run";
    excerpt?: string;
  }[];
  nextAction?: string;
};
```

## User-Facing Voice

OpenTag should sound concrete, open, and developer-native.

Good copy:

```text
OpenTag is the open mention layer for agents.
Tag Codex, Claude Code, Pi, or your own local runner from GitHub, Slack, or Lark.
```

```text
Claude Tag brings Claude into Slack. OpenTag brings any agent into any workspace.
```

```text
Your workspace stays collaborative. Your execution stays under your control.
```

Avoid:

- "AI teammate platform" as the primary phrase, because it sounds generic.
- "Slack bot clone", because it loses the protocol and local-runner angle.
- "Agent framework", because OpenTag should route agents, not replace them.

## Milestones

### Milestone 0: Public Concept

Deliverables:

- repository created.
- README with one-liner, comparison, and demo target.
- this design document.
- protocol draft with `OpenTagEvent`, `OpenTagRun`, and callback types.

Success:

- a developer can understand the idea in less than one minute.
- a future contributor can see what to build first.

### Milestone 1: GitHub Mention To Queued Run

Deliverables:

- Probot app receives GitHub comments.
- `@opentag` mention detection works.
- GitHub event normalizes into `OpenTagEvent`.
- run is created in a simple store.
- acknowledgement comment is posted.

Success:

- commenting `@opentag investigate this` on an allowed issue creates a run and posts an acknowledgement.

### Milestone 2: Local Daemon Claim And Execute

Deliverables:

- `opentagd` can pair with the app.
- repo-to-local-path mapping exists.
- daemon polls for queued runs.
- daemon claims and starts an executor adapter.
- status updates are posted back.

Success:

- a local runner receives a GitHub-triggered run and executes a no-op or echo adapter end to end.

### Milestone 3: Coding Agent Adapter

Deliverables:

- Codex, Claude Code, or oh-my-pi adapter.
- worktree or branch isolation.
- final summary capture.
- changed-file detection.
- GitHub final comment.

Success:

- `@opentag fix this` can produce a local code change and report what happened.

### Milestone 4: Pull Request Path

Deliverables:

- branch creation.
- push or patch export path.
- PR creation.
- verification summary in PR body.

Success:

- a tagged GitHub issue can result in a linked PR.

## Resolved V0 Decisions

- First real executor: Codex, with echo retained as the smoke-test executor.
- First public demo: local CLI/HTTP replay, while the Probot GitHub App path remains implemented for real installations.
- Minimum write approval model: write-capable work is constrained to an isolated branch plus pull request; direct writes to the target branch are not part of v0.
- Protocol schema: TypeScript/Zod schemas are the source of truth and `@opentag/core` exports public JSON Schema definitions for `OpenTagEvent`, `OpenTagRun`, and `OpenTagRunResult`.
- Orchestration framework: no Mastra dependency in v0; use lightweight TypeScript primitives until workflows justify a dedicated framework.

## Recommended First Implementation Decision

Use Probot for GitHub ingress, a very thin hosted dispatcher for run persistence and runner leasing, TypeScript for v0 implementation, and the local daemon as the differentiating path.

This gives the project a fast demo without sacrificing the bigger thesis:

```text
OpenTag is not a GitHub bot.
OpenTag is not an agent framework.
OpenTag is the open tag-to-run bridge between collaboration surfaces and agent executors.
```
