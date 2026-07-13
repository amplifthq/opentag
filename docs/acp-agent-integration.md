# Integrating an ACP agent with OpenTag

This guide describes the smallest correct integration for an ACP v1 agent. It
also explains the separate Channel role used by Slack, Lark, and other source
threads.

## What OpenTag and the agent each own

OpenTag is the ACP client. The configured agent process is the ACP server for one
disposable Attempt.

OpenTag owns:

- the durable Run and append-only audit history;
- Attempt creation, leases, fencing, cancellation, and recovery;
- workspace or scratch isolation and the absolute ACP `cwd`;
- input snapshots, policy, Connections, capability Grants, and approvals;
- material Action identity, idempotency, receipts, and reconciliation;
- source-thread status, approval, receipt, and final presentation.

The ACP agent owns:

- reasoning and task execution inside the supplied Attempt envelope;
- ACP capability negotiation and session updates;
- asking for permission before an ungranted tool action;
- returning useful output and verification through ACP.

An agent must not post directly to the source Slack or Lark thread. It must not
receive channel app credentials, dispatcher fencing tokens, or raw connector
secrets.

## Declare the Agent role

Add a named `opentag.integration.v1` manifest under `agents`:

```json
{
  "agents": {
    "example-acp": {
      "protocol": "opentag.integration.v1",
      "id": "example-acp",
      "label": "Example ACP Agent",
      "bindings": {
        "agent": {
          "kind": "stdio",
          "command": "example-agent",
          "args": ["acp"],
          "cwd": "relative/subdirectory"
        }
      },
      "roles": {
        "agent": {
          "protocol": "agent-client-protocol",
          "protocolVersion": 1,
          "binding": "agent"
        }
      },
      "resources": {}
    }
  }
}
```

The command may be an executable name or an absolute path. Binding `cwd`, when
present, must be relative to the explicit Attempt workspace and must resolve
inside it. Stdio bindings reject literal `env` maps. The child receives a
scrubbed process environment; credentials belong in an administrator-controlled
Connection or secret-reference resolver, not in a reusable manifest.

The map key, manifest `id`, and executor selection name must match. Selecting
`example-acp` causes the Generic ACP Host to launch the declared binding.

## ACP session lifecycle

For each Attempt, the host:

1. starts the configured process over stdio;
2. performs ACP initialization and capability negotiation;
3. creates a new session with the absolute Attempt `cwd`;
4. supplies a bounded task prompt and optional run-scoped MCP context;
5. consumes session updates as internal Attempt events;
6. mediates permission requests through OpenTag policy;
7. cancels and terminates the session when the Attempt ends.

The agent's actual file tools must honor the ACP session `cwd`. A Run may use an
isolated repository worktree or a repository-free scratch directory. Agents must
not assume that every task has a repository.

Raw session updates are never a channel delivery contract. Tool messages, plans,
reasoning updates, and routine progress remain audit-only. OpenTag derives a
small semantic presentation for human-facing milestones.

## Permission requests

An ACP permission request is untrusted input to OpenTag policy. It is not an
approval and is not rendered directly to a user.

OpenTag normalizes the requested action and returns one of three decisions:

- `allow_once` — authorize this exact action for the current Attempt;
- `allow_run` — authorize a safe structured scope for similar actions in this
  Run;
- `deny` — do not execute the action.

The default Mode is Auto. Auto silently permits requests already covered by a
deterministic policy and asks only when a governed decision is required. Ask and
Autonomous remain available, but every mode stays inside administrator-defined
Channel, Agent, Connection, and runtime boundaries. There is no required custom
user limit during basic setup.

For a material external action, authorization and execution are separate:

1. OpenTag creates a stable Action and immutable proposal scope.
2. Policy either authorizes it or publishes one normalized approval prompt.
3. The active fenced Attempt receives the decision.
4. A trusted connector executes the action when available.
5. OpenTag records a receipt and reconciles the Action outcome.

If execution may have happened but the outcome cannot be trusted, the Action is
`unknown` and automatic retry stops. An agent self-report alone is not trusted
evidence of external success.

Approval proposals are Attempt epochs. If the owning lease expires, an
unconsumed `allow_once` decision and its proposal are cancelled; a replacement
Attempt receives a new proposal and approval epoch. An explicit `allow_run`
grant remains Run-scoped. Decisions are accepted only while the proposal's
Attempt is current, active, unexpired, and the submitted epoch matches.

An operator can reconcile an `unknown` Action through the pairing-authenticated
control-plane endpoint. Reconciliation is a compare-and-set transition to
`succeeded` or `failed`, carries a stable idempotency key and sanitized evidence,
and writes both the Run audit event and control-plane audit record before a
single source-thread receipt callback is delivered.

## Channel integration

Channel adapters use `opentag.channel.v1`, not ACP. Native Slack and Lark
adapters normalize provider events into the same shape and render the same
semantic presentations independently.

A managed binding should include the configured provider application identity:

```json
{
  "channelBindings": [
    {
      "provider": "slack",
      "accountId": "T123",
      "conversationId": "C456",
      "ownership": {
        "mode": "managed",
        "exclusive": true,
        "applicationId": "A123",
        "botId": "U123"
      }
    }
  ]
}
```

`applicationId` and `botId` are opaque, bounded provider IDs. Display names are
not identity. Native adapters authenticate as a channel principal in dispatcher
request context. The dispatcher compares that authenticated principal with the
managed binding and rejects a request when it is missing or does not match.
Provider payloads and normalized event metadata remain useful for routing and
presentation, but are never trusted to establish application identity.

Channel membership and app scopes remain provider-administrator concerns. Agent
filesystem and process permissions remain agent-administrator concerns. OpenTag
administrators bind a Channel to an Agent, Connections, and Mode; OpenTag does
not synthesize a cross-provider principal for basic setup.

## Balanced source-thread UX

The default source-thread experience is one mutable Run Card:

| Event | Source-thread behavior |
| --- | --- |
| received | provider-native receipt or initial Run Card |
| queued / running | update the Run Card at a meaningful phase change |
| routine ACP/tool progress | audit-only |
| approval / blocker | visible attention state or prompt |
| material Action receipt | visible structured receipt |
| final | update the lifecycle card with summary and verification |

Slack uses Block Kit and Lark uses a native card when available. Both render from
the same semantic presentation model and reuse a stable `runId:status` lifecycle
key. Raw ACP JSON-RPC frames, hidden reasoning, credentials, local secret values,
and fencing tokens must never appear in these presentations.

## Hermes in both roles

Hermes can provide a Channel gateway and an ACP Agent, but they are two separate
runtime identities:

```json
{
  "agents": {
    "hermes-acp": {
      "protocol": "opentag.integration.v1",
      "id": "hermes-acp",
      "label": "Hermes ACP",
      "bindings": {
        "agent": {
          "kind": "stdio",
          "command": "hermes",
          "args": ["acp"]
        }
      },
      "roles": {
        "agent": {
          "protocol": "agent-client-protocol",
          "protocolVersion": 1,
          "binding": "agent"
        }
      },
      "resources": {}
    }
  },
  "channelBindings": [
    {
      "provider": "lark",
      "accountId": "tenant_1",
      "conversationId": "oc_chat",
      "ownership": {
        "mode": "managed",
        "exclusive": true,
        "applicationId": "cli_channel_app",
        "botId": "ou_channel_bot"
      }
    }
  ],
  "approvalMode": "auto"
}
```

The Hermes gateway profile holds only channel transport credentials and forwards
eligible events. The `hermes acp` process receives only the Attempt envelope and
granted capabilities. Use separate processes, environment variables, profiles,
credential sets, logs, and supervision even when both run on one machine.

## Conformance checklist

Before describing an ACP integration as ready, verify that it:

- completes ACP initialization and a fresh session over stdio;
- honors the absolute Attempt `cwd` for its real tools;
- works in both repository worktrees and repository-free scratch directories;
- supports cancellation without changing a cancelled Run to success;
- routes permission requests through OpenTag instead of prompting separately;
- cannot access channel credentials or raw connector credentials;
- emits no raw ACP/tool/reasoning chatter into source threads;
- leaves material Action execution fenced, receipted, and retry-safe;
- produces a normalized final summary and verification evidence.

Run `corepack pnpm smoke:governance` and `corepack pnpm smoke:privacy` alongside
the relevant package tests. Use `opentag status --run <run_id>` for detailed
audit events that intentionally do not appear in chat.
