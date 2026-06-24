# Troubleshooting

Use this path when an OpenTag setup does not create, claim, execute, or callback a run.

## Split The Failure

Check these layers in order. Stop at the first failing layer and report the exact error.

1. Dispatcher health
2. Pairing token authorization
3. Runner registration
4. Repository binding
5. Slack channel binding, when Slack is in scope
6. Run creation
7. Runner claim
8. Executor execution
9. Callback delivery

## Checks

Dispatcher:

```bash
curl http://localhost:3030/healthz
```

Auth:

```bash
curl -i http://localhost:3030/v1/runs/run_demo_1
```

If the dispatcher has `OPENTAG_PAIRING_TOKEN`, every `/v1/*` request must use `Authorization: Bearer <token>`.

Repository binding:

```bash
curl http://localhost:3030/v1/repo-bindings/github/acme/demo
```

Slack binding:

```bash
curl http://localhost:3030/v1/slack-channel-bindings/T123/C123
```

Run state and events:

```bash
curl http://localhost:3030/v1/runs/run_demo_1
curl http://localhost:3030/v1/runs/run_demo_1/events
```

## Common Errors

- `unauthorized`: pairing token mismatch or missing bearer token.
- `repo_context_missing`: run event metadata does not include `owner` and `repo`.
- `repo_not_bound`: run repository was not bound to a runner.
- `actor_not_allowed_for_write`: write-capable run came from an actor outside the binding allowlist.
- `slack_channel_binding_not_found`: Slack team/channel is not bound to a repo.
- `run_not_claimed_by_runner`: heartbeat came from the wrong runner or after lease loss.
- `No OpenTag run available`: no pending run is claimable for that runner's bindings.

## Callback Debugging

Callback delivery is separate from execution success.

- GitHub callbacks need `OPENTAG_GITHUB_TOKEN` on the dispatcher.
- Slack callbacks need `OPENTAG_SLACK_BOT_TOKEN` on the dispatcher.
- Missing callback credentials should not be treated as executor failure.
- Inspect run events for `callback.*.delivered` before claiming callbacks work.
