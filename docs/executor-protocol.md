# OpenTag Executor Protocol

`opentag.executor.v1` is the first role protocol for replacing one-off executor
adapters with one governed run contract. New executors are declared through an
`opentag.integration.v1` manifest, then the executor role uses this runtime
contract for workspace isolation, session isolation, semantic run refs,
permission context, progress, completion, and source-control handoff.

## Why This Exists

Today each built-in executor translates an OpenTag run into a vendor-specific
CLI invocation. That keeps the first integration simple, but it also repeats the
same hard parts in every adapter:

- Create an isolated branch or worktree.
- Assemble the request, context packet, policy text, and report expectations.
- Ensure the agent's real file tools use the OpenTag run workspace.
- Ensure session or conversation history is scoped to the current run unless
  reuse is explicit.
- Parse progress and final output.
- Clean internal artifacts without hiding the real executor failure.
- Read changed files and let OpenTag own commit, push, and pull-request handoff.

The OpenClaw review exposed why process `cwd` alone is not enough. A CLI can run
from one directory while its agent file tools use another configured workspace
or a long-lived gateway session. The protocol makes that failure mode explicit:
the shim must acknowledge the actual workspace used by its tools, and OpenTag
rejects the run when it does not match the requested run workspace.

## Version, Profile, And Binding

The executor role protocol is `opentag.executor.v1`.

Only one profile is implemented in this prototype:

- `stdio-jsonl-basic`: OpenTag starts a child process, writes one JSON request line to
  stdin, then reads JSON Lines events from stdout. Stderr is treated as diagnostic
  text. The child must emit one terminal `completed` or `failed` event.

Only one binding kind is implemented in this prototype:

- `stdio-jsonl`: a local command, optional args, optional cwd, and optional
  non-secret environment values. Future bindings can add HTTP, long-running
  runtimes, MCP, containers, or hook-ingest callbacks without changing the run
  contract.

## Manifest

A protocol executor is registered as the `executor` role inside an integration
manifest:

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
      "binding": "executorStdio",
      "capabilities": {
        "workspaceIsolation": "worktree",
        "conversationAccess": "request",
        "progressEvents": "audit",
        "supportsCancel": false,
        "supportsStreaming": false
      }
    }
  }
}
```

The manifest says which role protocol/profile the integration implements and
which named binding launches it. It does not make policy decisions. OpenTag still
owns admission, workspace setup, changed-file detection, and source-control
handoff. See [Integration Taxonomy](./integration-taxonomy.md) for the role,
resource-domain, binding, and connection-instance boundaries.

## Run Request

OpenTag writes one request JSON line to the child stdin:

```json
{
  "protocol": "opentag.executor.v1",
  "runId": "run_123",
  "workspace": {
    "path": "/tmp/opentag/worktrees/run_123",
    "baseBranch": "main",
    "branchName": "opentag/run_123",
    "isolation": "worktree"
  },
  "session": {
    "scope": "run",
    "key": "opentag:example-agent:run_123"
  },
  "command": {
    "rawText": "fix this bug",
    "intent": "fix",
    "args": {}
  },
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
  ],
  "context": [],
  "permissions": [],
  "metadata": {},
  "sourceControl": {
    "owner": "opentag",
    "forbiddenCommands": ["git add", "git commit", "git push", "gh pr create"]
  }
}
```

Session keys default to per-run scope and include the run id. A shim can support
other scopes later, but cross-run conversation reuse must be explicit. A global
default session key is not valid for this protocol.

`source`, `targets`, and `replyTo` are sanitized semantic refs. They tell the
executor where the request came from, what it is acting on, and where progress or
final output should return. They do not carry provider credentials, workspace or
account connection state, raw webhook payloads, or API tokens.

## Events

The child stdout is JSON Lines. Each line is one event.

Progress events:

```json
{"type":"started","message":"Starting example agent"}
{"type":"progress","message":"Editing files"}
```

Completed event:

```json
{
  "type": "completed",
  "message": "Done",
  "actualWorkspacePath": "/tmp/opentag/worktrees/run_123",
  "summary": "Implemented the fix.",
  "verification": [
    {"command":"corepack pnpm test","outcome":"passed","summary":"Tests passed."}
  ],
  "artifacts": [],
  "risks": []
}
```

Failed event:

```json
{
  "type": "failed",
  "message": "Agent failed before editing files",
  "actualWorkspacePath": "/tmp/opentag/worktrees/run_123"
}
```

The completed or failed event must include the actual workspace path when the
shim knows it. For successful completion, OpenTag requires
`actualWorkspacePath` to resolve to exactly the requested `workspace.path`.

## Conformance Rules

A conforming shim must:

- Read one `opentag.executor.v1` request from stdin.
- Bind its real file tools to `request.workspace.path`.
- Return `actualWorkspacePath` in the final event.
- Treat `request.session.key` as the only default conversation/session key.
- Keep source-control handoff with OpenTag. The shim must not run or recommend
  `git add`, `git commit`, `git push`, or `gh pr create`.
- Emit a final `completed` or `failed` event.
- Avoid secrets in progress, artifacts, and summaries.

The generic OpenTag protocol executor must:

- Accept an `opentag.integration.v1` manifest with `roles.executor.profile` set
  to `stdio-jsonl-basic`.
- Resolve the executor role's named `stdio-jsonl` binding.
- Create the run branch or worktree before launching the shim.
- Validate protocol events and fail on malformed JSONL.
- Reject workspace mismatches.
- Clean internal `.omx`, `.codex`, and `.claude` artifacts.
- Preserve the primary child failure if cleanup also fails.
- Read changed files after completion and build the normal OpenTag run result.

## Migration Plan

This prototype deliberately does not migrate Codex, Claude Code, Hermes, or
OpenClaw. The migration path should be staged:

1. Fake conformance shim and generic executor tests using
   `opentag.integration.v1` plus the `stdio-jsonl-basic` executor profile.
2. One real external-agent shim, likely OpenClaw or Hermes, to prove workspace
   and session isolation against a real agent runtime.
3. Codex and Claude Code after parity tests cover sandbox mode, permission mode,
   environment scrubbing, no session persistence, report parsing, and
   source-control handoff.

That order keeps the protocol from becoming a thin wrapper around one existing
CLI's flags while still moving the codebase toward one generic executor plus
small shims.
