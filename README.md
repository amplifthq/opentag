# OpenTag

**Open agent mentions for every workspace.**

[![Status](https://img.shields.io/badge/status-v0-blue)](#status)
[![npm](https://img.shields.io/npm/v/@opentag/core?label=npm)](https://www.npmjs.com/org/opentag)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22.x-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

Claude Tag showed the new interface for team AI: tag an agent where work is already happening, let it use the right tools, and get the result back in the thread.

Tag agents from GitHub, Slack, or your own workspace surface. OpenTag adds bounded context, explicit permissions, auditable execution, and local-first runners when you need them.

OpenTag is not another AI workspace. It is the protocol layer that brings agents to the work item thread you already use.

> OpenTag is not affiliated with Anthropic. It is an open implementation of the agent-mention workflow that Claude Tag made obvious.

```mermaid
flowchart LR
  A["GitHub or Slack mention"] --> B["OpenTag event"]
  B --> C["Hosted or embedded dispatcher"]
  C --> D["Bound local daemon"]
  D --> E["Claude Code, Codex, or custom runner"]
  E --> F["Proposal, PR, callback, metrics"]
```

Real smoke tests have validated:

- GitHub issue -> OpenTag -> local Claude Code -> commit branch -> pull request -> GitHub callback
- Slack thread -> OpenTag -> local Claude Code -> Slack final callback with audit-only progress

## Why OpenTag

Claude Tag is a strong product signal: teams want to tag AI into shared work, not copy context into another chat window. But the first release is Claude-first, Slack-first, and available in beta for Claude Enterprise and Team.

OpenTag is for developers and teams who want the same interaction model with open control:

| Claude Tag pattern | OpenTag approach |
| --- | --- |
| Tag `@Claude` in Slack | Tag `@opentag` from GitHub, Slack, or another adapter |
| Claude executes with configured tools | Any approved executor can run: Claude Code, Codex, Hermes, OpenClaw, or custom |
| Agent identity is provisioned by admins | Repository and channel bindings are explicit, auditable records |
| Work happens inside Anthropic's product boundary | Dispatch can be self-hosted, embedded, or pointed at local runners |
| Results come back to the thread | Results can be comments, progress updates, audit events, branches, or PRs |

The goal is simple: make "tag an agent into work" a protocol, not a closed surface.

## What Works Today

### Core Loop

- **GitHub and Slack ingress** - issue comments, PR review comments, and Slack app mentions normalize into one `OpenTagEvent`.
- **Local-first execution** - `opentagd` claims only explicitly bound repositories and runs in your local checkout.
- **Built-in local executors** - `echo` for smoke tests, `claude-code` for `claude --print`, and `codex` for `codex exec`.
- **Quiet callbacks** - Slack progress stays audit-only by default; GitHub updates one run comment in place.

### Protocol Runtime

- **Work-thread model** - runs attach to `WorkItemReference + ConversationAnchor`, not an internal shadow task.
- **Context packets** - execution input is assembled through collect, classify, filter, preserve, summarize, budget, and emit stages.
- **Suggested changes** - agents can return immutable `SuggestedChangesSnapshot` objects with semantic mutation intents.
- **Approval and apply** - approvals create separate decision objects; apply plans produce per-intent outcomes.
- **Policy and mappings** - repo-scoped policy rules and mutation mappings compile semantic intents into adapter operations.
- **Metrics** - run, repo, and work-thread metrics expose thread noise, proposal counts, approvals, child runs, and apply outcomes.

## Quick Start

Requires Node 22.x and pnpm 9.x.

Install the published package family:

```bash
pnpm add @opentag/core @opentag/client @opentag/dispatcher @opentag/github @opentag/slack @opentag/runner @opentag/store
```

Or work from this repository:

```bash
pnpm install
pnpm test
pnpm smoke:protocol
pnpm smoke:slack-protocol
pnpm build
```

For no-secret protocol smoke tests, run `pnpm smoke:protocol` and `pnpm smoke:slack-protocol`. They start an in-process dispatcher with a temporary SQLite database and exercise the protocol chain through the client SDK.

For a full local GitHub-to-runner smoke test, follow [examples/github-to-echo](examples/github-to-echo/README.md). It starts the dispatcher, binds a local runner, creates a sample GitHub-shaped run, executes it with the echo executor, and lets you inspect the audit log.

## Run Claude Code Locally

Set a repository binding to use the built-in Claude Code executor:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3031",
  "pairingToken": "dev_pairing_token",
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "claude-code",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ]
}
```

Then register, bind, and run the daemon:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- serve
```

For real local smoke tests:

```bash
scripts/dev/run-gh-claude-local-test.sh
scripts/dev/run-slack-claude-local-test.sh
```

Both scripts use real platform callbacks while keeping execution local.

## Agent Skill

Install the OpenTag skill for any supported agent:

```bash
npx skills add https://github.com/amplifthq/opentag --skill opentag --agent '*'
```

## Try The Local Echo Loop

Start the dispatcher:

```bash
OPENTAG_DATABASE_PATH=opentag.db pnpm --filter @opentag/dispatcher-app dev
```

Create `opentag.local.json`:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "pollIntervalMs": 5000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "echo",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ]
}
```

Register and bind the local runner:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
```

Create a run and execute once:

```bash
curl -X POST http://localhost:3030/v1/runs \
  -H 'content-type: application/json' \
  -d @examples/github-to-echo/run.example.json

OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

Inspect the result:

```bash
curl http://localhost:3030/v1/runs/run_demo_1
curl http://localhost:3030/v1/runs/run_demo_1/events
```

## How It Works

1. **Ingress normalizes platform events.** GitHub and Slack adapters translate comments or app mentions into one `OpenTagEvent` schema.
2. **The dispatcher validates scope.** Runs must include repository metadata, and the repository must be explicitly bound to a runner.
3. **The local daemon claims only mapped work.** `opentagd` checks its local repository config before running an executor.
4. **The executor does the work.** The echo executor proves the loop; Claude Code and Codex create isolated `opentag/<runId>` branches and run the local CLI.
5. **Protocol artifacts capture the outcome.** Results can include suggested changes, next-action hints, proposal lineage, approval decisions, apply plans, and per-intent apply outcomes.
6. **Callbacks and audit events close the loop.** Human threads get quiet ack/final callbacks, while detailed progress and metrics stay queryable through the dispatcher.

## Packages

Current public release: `0.1.0`.

| Package | Purpose |
| --- | --- |
| [`@opentag/core`](https://www.npmjs.com/package/@opentag/core) | Zod schemas, TypeScript types, protocol helpers, mention parsing, and JSON Schema exports |
| [`@opentag/client`](https://www.npmjs.com/package/@opentag/client) | HTTP client for ingress apps, local runners, admin setup, proposals, approvals, apply plans, policy, mappings, and metrics |
| [`@opentag/dispatcher`](https://www.npmjs.com/package/@opentag/dispatcher) | Embeddable Hono dispatcher and callback sinks |
| [`@opentag/github`](https://www.npmjs.com/package/@opentag/github) | GitHub event normalization, comment rendering, PR helpers, and issue mutation compilation/apply helpers |
| [`@opentag/slack`](https://www.npmjs.com/package/@opentag/slack) | Slack event normalization, thread keys, and callback helpers |
| [`@opentag/store`](https://www.npmjs.com/package/@opentag/store) | SQLite/Drizzle persistence for runs, audit events, proposals, approvals, apply plans, policy, mappings, leases, and metrics |
| [`@opentag/runner`](https://www.npmjs.com/package/@opentag/runner) | Executor contracts plus echo, Claude Code, and Codex executor adapters |

Runnable apps:

| App | Purpose |
| --- | --- |
| `apps/dispatcher` | Hosted dispatcher process |
| `apps/opentagd` | Local daemon that claims and executes runs |
| `apps/github-probot` | GitHub App ingress |
| `apps/slack-events` | Slack Events API ingress |

## SDK Usage

Normalize a GitHub comment and enqueue it:

```ts
import { createOpenTagClient } from "@opentag/client";
import { normalizeGitHubIssueComment } from "@opentag/github";

const event = normalizeGitHubIssueComment({
  id: String(payload.comment.id),
  commentBody: payload.comment.body,
  commentUrl: payload.comment.html_url,
  apiCommentsUrl: payload.issue.comments_url,
  issueUrl: payload.issue.html_url,
  issueNumber: payload.issue.number,
  owner: payload.repository.owner.login,
  repo: payload.repository.name,
  actorId: payload.sender.id,
  actorLogin: payload.sender.login,
  private: payload.repository.private,
  receivedAt: new Date().toISOString()
});

if (event) {
  const client = createOpenTagClient({
    dispatcherUrl: process.env.OPENTAG_DISPATCHER_URL!,
    pairingToken: process.env.OPENTAG_DISPATCHER_TOKEN
  });

  await client.createRun({
    runId: `run_${Date.now()}`,
    event
  });
}
```

Embed the dispatcher in another Hono-compatible service:

```ts
import { createDispatcherApp, createGitHubCallbackSink } from "@opentag/dispatcher";

export const dispatcher = createDispatcherApp({
  databasePath: "opentag.db",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN,
  callbackSink: createGitHubCallbackSink({
    token: process.env.OPENTAG_GITHUB_TOKEN
  })
});
```

## Executor Model

OpenTag treats executors as adapters, not as the center of the system.

An executor receives:

- `runId`
- `workspacePath`
- normalized command text
- context pointers from the source workspace

It returns:

- conclusion
- human-readable summary
- changed files
- verification results
- optional artifacts such as a branch or pull request

The built-in Codex and Claude Code executors refuse dirty workspaces, create an isolated branch, run the local CLI (`codex exec` or `claude --print`), filter internal artifacts, report changed files, and return structured `OpenTagRunResult` objects. When PR creation is allowed, `opentagd` commits executor-produced file changes before pushing the run branch and opening a pull request. Third-party runners can implement the same `ExecutorAdapter` contract from `@opentag/runner`.

## Protocol Runtime

OpenTag's runtime is centered on engineering work item threads, not chat transcripts. The core protocol surface includes:

- `WorkItemReference`, `ConversationAnchor`, and `WorkThread` for durable work context.
- `ContextPacket` assembly with collect, classify, filter, preserve, summarize, budget, and emit stages.
- `RunEvent` visibility and importance for quiet callbacks and audit/debug timelines.
- `SuggestedChangesSnapshot` and semantic `MutationIntent` objects.
- `ApprovalDecision` and `ApplyPlan` objects with per-intent outcomes.
- `ActionHint` values that can create child runs with lineage back to parent runs, proposals, and apply plans.
- Repo-scoped policy rules and mutation mappings for adapter compilation.
- Run, repo, and work-thread metrics including thread noise ratio, proposal counts, approval counts, child runs, and apply outcome counts.

GitHub issue mutations currently support labels and assignees directly. Status and priority are available through explicit repo mutation mappings, for example `priority: P1 -> label: priority/P1`.

## Dispatcher Callback Delivery

Set `OPENTAG_GITHUB_TOKEN` on the dispatcher to post acknowledgement, progress, and final callback messages to GitHub comments.

GitHub callbacks update one comment per run in place. The first callback creates the run comment, and later progress/final callbacks patch that same comment instead of flooding the issue thread.

When dispatcher callbacks are enabled, set `OPENTAG_DISPATCHER_OWNS_CALLBACKS=true` on the Probot app to avoid duplicate acknowledgement comments.

Set `OPENTAG_SLACK_BOT_TOKEN` on the dispatcher to post acknowledgement and final callback messages to Slack threads through `chat.postMessage`. Routine Slack progress remains audit-only by default.

Set `OPENTAG_PAIRING_TOKEN` on the dispatcher to require a shared Bearer token for `/v1/*` endpoints. Use the same value as `pairingToken` in `opentagd` config, and set `OPENTAG_DISPATCHER_TOKEN` on ingress apps that create runs through the dispatcher.

## Examples

- [GitHub to echo](examples/github-to-echo/README.md) - manual end-to-end GitHub-shaped smoke test.
- [Embedded dispatcher](examples/embedded-dispatcher/README.md) - host the dispatcher inside another Node service.
- [Custom runner](examples/custom-runner/README.md) - build a third-party runner with `@opentag/client` and `@opentag/runner`.
- `scripts/test/protocol-runtime-smoke.ts` - in-process GitHub-shaped protocol runtime smoke test.
- `scripts/test/slack-protocol-runtime-smoke.ts` - in-process Slack-shaped protocol runtime smoke test.
- `scripts/dev/run-gh-claude-local-test.sh` - GitHub CLI-assisted real local Claude Code smoke test.
- `scripts/dev/run-slack-claude-local-test.sh` - Slack API-assisted real local Claude Code smoke test.

## Real Integration Guides

- [Real integration smoke test](docs/real-integration-smoke-test.md) - real GitHub and Slack setup, trigger, and debugging order based on an actual end-to-end validation pass.
- `scripts/dev/start-github-test.sh` - starts the dispatcher, local daemon, and GitHub Probot ingress for a real GitHub smoke test.
- `scripts/dev/start-slack-test.sh` - starts the dispatcher, local daemon, and Slack Events ingress for a real Slack smoke test.
- `scripts/dev/start-github-slack-claude-test.sh` - starts GitHub ingress, Slack ingress, dispatcher, and a local Claude Code daemon for combined real testing.

## Status

OpenTag is a young v0 project. The current codebase proves the core loop:

- GitHub and Slack ingress
- normalized protocol schemas
- dispatcher persistence, leases, proposals, approvals, apply plans, policy, mappings, lineage, and metrics
- local daemon polling and heartbeats
- echo, Claude Code, and Codex executors
- GitHub and Slack callbacks with quiet defaults
- package-level SDK usage

Next areas of work:

- richer hosted setup flow
- GitHub Project field mapping for status and priority
- more workspace adapter compilers
- adapter-specific context packet redaction and classification hooks
- production hardening for multi-tenant dispatcher deployments

## Design

The architecture and product direction are documented in [docs/design.md](docs/design.md). Versioning and publishing rules live in [docs/versioning.md](docs/versioning.md).

## License

OpenTag is licensed under the MIT License. See [LICENSE](LICENSE).
