# GitHub To Echo Demo

This demo proves the OpenTag v0 loop without needing a real coding agent.

## Flow

```text
@opentag fix this
-> GitHub Probot ingress
-> hosted dispatcher run
-> opentagd local daemon
-> echo executor
-> final callback text
```

## Local Manual Path

1. Start the dispatcher:

```bash
OPENTAG_DATABASE_PATH=opentag.db pnpm --filter @opentag/dispatcher dev
```

2. Create a local daemon config:

```bash
cat > opentag.local.json <<'JSON'
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
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
JSON
```

3. Register the runner and bind its repository:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
```

4. Create a run with a normalized event payload:

```bash
curl -X POST http://localhost:3030/v1/runs \
  -H 'content-type: application/json' \
  -d '{
    "runId": "run_demo_1",
    "event": {
      "id": "evt_demo_1",
      "source": "github",
      "sourceEventId": "comment_demo_1",
      "receivedAt": "2026-06-24T00:00:00.000Z",
      "actor": { "provider": "github", "providerUserId": "42", "handle": "octocat" },
      "target": { "mention": "@opentag", "agentId": "opentag" },
      "command": { "rawText": "fix this", "intent": "fix", "args": {} },
      "context": [
        { "kind": "github.issue", "uri": "https://github.com/acme/demo/issues/1", "visibility": "public" }
      ],
      "permissions": [
        { "scope": "issue:comment", "reason": "reply to source thread" }
      ],
      "callback": {
        "provider": "github",
        "uri": "https://api.github.com/repos/acme/demo/issues/1/comments"
      },
      "metadata": { "owner": "acme", "repo": "demo" }
    }
  }'
```

5. Run the daemon once:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

6. Inspect the stored run and audit events:

```bash
curl http://localhost:3030/v1/runs/run_demo_1
curl http://localhost:3030/v1/runs/run_demo_1/events
```

## Codex And PR Path

Switch the config to `"defaultExecutor": "codex"` to run a real Codex CLI execution in the mapped checkout. To let OpenTag create pull requests, add a GitHub token:

```json
{
  "runnerId": "runner_local",
  "dispatcherUrl": "http://localhost:3030",
  "githubToken": "ghs_optional_token_for_pr_creation",
  "repositories": [
    {
      "provider": "github",
      "owner": "acme",
      "repo": "demo",
      "checkoutPath": "/Users/example/repos/demo",
      "defaultExecutor": "codex",
      "baseBranch": "main",
      "pushRemote": "origin"
    }
  ]
}
```

When a `fix` command changes files, OpenTag creates an `opentag/<runId>` branch, pushes it, and opens a PR against `baseBranch`.
