# OpenTag Integration Taxonomy

OpenTag integrations are role-based. A single integration package may expose an
Agent role, a Channel role, or both, but each role keeps an independent binding,
process, credential set, and lifecycle.

## Discovery envelope

`opentag.integration.v1` is the versioned discovery and configuration envelope.
It declares:

- an integration ID and human-readable label;
- named process bindings;
- the roles that use those bindings;
- the resource domains the integration can reference.

The manifest is not a runtime event stream and must not contain credentials.

```json
{
  "protocol": "opentag.integration.v1",
  "id": "hermes-acp",
  "label": "Hermes ACP",
  "bindings": {
    "agent": {
      "kind": "stdio",
      "command": "hermes",
      "args": ["acp"],
      "env": {}
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
```

## Active roles

| Role | Runtime contract | Responsibility |
| --- | --- | --- |
| `agent` | ACP v1 | Performs one disposable Attempt inside the workspace and capability envelope supplied by OpenTag. |
| `channel` | `opentag.channel.v1` | Normalizes provider events and renders semantic OpenTag presentations in the source thread. |

OpenTag Core, not either integration role, owns durable Runs, admission, policy,
approvals, grants, material Action identity, receipts, reconciliation, and audit.

An integration that provides both roles does not become a combined trusted
runtime. For example, a Hermes channel gateway and `hermes acp` use separate
bindings and profiles. Channel credentials never enter the ACP Attempt, and ACP
capabilities never enter the channel process.

## Resource domains

Resource domains are semantic references, not active roles:

| Domain | Meaning |
| --- | --- |
| `repo` | repository, branch, commit, working tree, and file refs |
| `changeRequest` | pull request, merge request, review, and checks |
| `workItem` | issue, ticket, task, assignee, labels, and state |
| `context` | document, wiki, search, memory, and source-thread refs |
| `identity` | provider account, tenant, actor, installation, and authorization boundary |

A Run may be repository-free. Resource references tell OpenTag what the work may
touch; they do not require every task to bind a repository.

## Bindings and connections

A manifest binding explains how to start a role. A Connection is configured
resource access. They are intentionally different:

- a `stdio` binding can start an ACP agent without granting it a GitHub, Linear,
  Slack, or Lark credential;
- a channel binding identifies an allowed provider tenant and conversation;
- a ConnectionRef identifies an external resource account without embedding its
  secret in Run data;
- a run-scoped Grant determines which exact capability may be used.

Raw credentials remain in the adapter, connector, or credential broker that
owns them. Core stores structured references, decisions, receipts, and evidence.

## Channel ownership

A managed channel binding is exclusive to one configured application identity:

```json
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
```

`applicationId` and optional `botId` identify the configured adapter application.
For authorization, the dispatcher trusts only the authenticated channel
principal attached to the request context and compares that principal with the
binding. Provider payloads, normalized event metadata, actor fields, and display
names are routing or presentation data; none of them can establish channel
ownership. A managed request with no matching authenticated principal is
rejected before Run admission.

Binding creation, replacement, and deletion are administrator operations. An
ordinary source-thread actor cannot claim ownership by supplying metadata.

## Runtime flow

1. A Channel adapter normalizes a provider event as `opentag.channel.v1`.
2. OpenTag verifies the managed application identity and admits a durable Run.
3. A Worker creates an Attempt and hosts the selected Agent role through ACP.
4. ACP updates become audit events; they are not forwarded as raw chat output.
5. OpenTag renders normalized status, approval, receipt, and final presentations
   through the originating Channel adapter.

Slack and Lark implement the same contract independently. Neither provider is
proxied through the other, and cross-channel collaboration is not required.

## Presentation boundary

Balanced delivery is the default:

- routine ACP progress, tool updates, hidden reasoning, heartbeats, and retries
  stay audit-only;
- queued and running milestones update one source-thread Run Card;
- approvals, blockers, and material Action receipts are visible;
- the final summary updates the same lifecycle card when the provider supports
  message replacement.

Channel renderers receive semantic presentations. They may produce Slack Block
Kit, a Lark card, or plain text, but raw ACP frames, credentials, fencing tokens,
and provider secrets are never presentation input.
