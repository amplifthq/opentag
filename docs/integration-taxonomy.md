# OpenTag Integration Taxonomy

> **Direction note:** The role-based taxonomy and `opentag.integration.v1`
> manifest remain the intended discovery model. The executor examples below
> describe the current prototype; the accepted target uses standard ACP v1 with
> a separate `stdio` binding and adds the Channel role defined in
> [ACP-First Agent Runtime and Channel Integration](./acp-first-agent-runtime-design.md).

OpenTag integrations are role-based, not vendor-based. A vendor integration can
implement one or more roles and expose one or more resource domains. This keeps
new platform work bounded: each adapter implements the boundary it owns instead
of re-creating the whole OpenTag runner loop.

## Integration Definition

`opentag.integration.v1` is a manifest and discovery envelope. It answers:

- who the integration is;
- which role protocols it implements;
- which resource domains it can reference or operate on;
- which named bindings OpenTag can use to connect to it.

It is not a runtime event protocol. Runtime semantics stay in role protocols
such as `opentag.executor.v1` and future `opentag.channel.v1`.

```json
{
  "protocol": "opentag.integration.v1",
  "id": "example-agent",
  "label": "Example Agent",
  "bindings": {
    "executorStdio": {
      "kind": "stdio-jsonl",
      "command": "example-agent",
      "args": ["opentag-exec"]
    }
  },
  "roles": {
    "executor": {
      "protocol": "opentag.executor.v1",
      "profile": "stdio-jsonl-basic",
      "binding": "executorStdio"
    }
  }
}
```

## Roles

Roles describe the active part an integration plays in the OpenTag work loop.

| Role | Responsibility | Examples |
| --- | --- | --- |
| `executor` | Executes a governed run in a workspace and returns progress, completion, verification, and artifacts. | Codex, Claude Code, Hermes, OpenClaw |
| `channel` | Receives human messages or actions and replies to the source thread. | Slack, Lark, Discord, Telegram, GitHub comments |

Only `executor` is implemented in the first prototype. Future roles should add
their own role protocol and conformance profiles instead of overloading
`opentag.integration.v1`.

## Resource Domains

Resource domains are not active roles. They are semantic domains that a run can
reference or an adapter can operate on.

| Domain | Meaning |
| --- | --- |
| `repo` | repository, branch, commit, working tree, file refs |
| `changeRequest` | pull request, merge request, review, checks, merge readiness |
| `workItem` | issue, ticket, task, assignee, labels, state |
| `context` | docs, wiki, search results, memory, source links |
| `identity` | user, team, account, installation, permission boundary |

For example, GitHub can be a channel, repo provider, change-request provider,
work-item provider, and identity provider. Slack is usually a channel plus
identity provider. Linear is usually a work-item provider, and may be a channel
only if Linear comments are used as the source thread.

## Bindings

Bindings describe how OpenTag connects to an integration. They are declared once
on the integration manifest and referenced by roles:

```json
{
  "bindings": {
    "executorStdio": {
      "kind": "stdio-jsonl",
      "command": "example-agent",
      "args": ["opentag-exec"],
      "env": {
        "EXAMPLE_NON_SECRET_MODE": "1"
      }
    }
  },
  "roles": {
    "executor": {
      "protocol": "opentag.executor.v1",
      "profile": "stdio-jsonl-basic",
      "binding": "executorStdio"
    }
  }
}
```

The first prototype implements only `stdio-jsonl`. Future bindings can model
HTTP, webhook, socket, MCP, local service, or container-based connections without
changing the executor run contract.

Manifests must not include workspace, account, or installation secrets. Literal `env` values are for
non-secret launch configuration only.

## Connection Instances

Hosted or managed OpenTag deployments should separate integration definitions
from workspace connection state:

- `IntegrationDefinition`: versioned manifest, roles, resource domains, bindings,
  profiles, and conformance expectations. It is reusable and contains no workspace
  secrets.
- `ConnectionInstance`: a workspace connection to one external account for
  one integration, such as a GitHub App installation, Slack workspace, Lark tenant,
  Linear workspace, or remote executor account.
- `ResolvedBinding`: runner-internal runtime handle after the control plane has
  resolved the connection, credential, scopes, and installation boundary.

`ConnectionInstance` is intentionally not part of this prototype schema. The
current code standardizes integration definitions and sanitized run refs first;
workspace-scoped credential and hosted connect lifecycle can be added in the
control plane when there is a real runtime consumer.

## Run Semantics

A run can reference multiple systems without giving the executor direct platform
credentials:

```json
{
  "source": {
    "kind": "channel_message",
    "channel": { "provider": "slack", "id": "C123" },
    "thread": { "provider": "slack", "id": "171234.5678" },
    "actor": { "provider": "slack", "id": "U123" }
  },
  "targets": {
    "repo": { "provider": "github", "owner": "amplifthq", "name": "opentag" },
    "changeRequest": { "provider": "github", "id": "79", "number": 79 }
  },
  "replyTo": [
    {
      "channel": { "provider": "slack", "id": "C123" },
      "thread": { "provider": "slack", "id": "171234.5678" },
      "purpose": "all"
    }
  ]
}
```

The executor receives sanitized semantic refs. The runner or future control
plane resolves connection IDs, credentials, permissions, and concrete API calls.
It also owns response routing: for each semantic delivery, it selects every
`replyTo` entry whose purpose is `all` or the matching `progress`, `final`,
`error`, or `approval` purpose. Executor `started` and `progress` events map to
`progress`, `completed` maps to `final`, and `failed` maps to `error`. The flat
event result is shared across the selected targets and rendered by their channel
adapters; executors do not split payloads or deliver to providers directly.
