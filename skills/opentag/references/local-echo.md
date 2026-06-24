# Local Echo Loop

Use this path to prove OpenTag works without GitHub, Slack, tokens, or a real coding agent.

## Required Values

- `runnerId`: local runner id, usually `runner_local`
- `dispatcherUrl`: usually `http://localhost:3030`
- Repository owner and repo name, such as `acme/demo`
- Absolute local checkout path for that repository

## Minimal Config

Create a local config file such as `opentag.local.json`:

```bash
pnpm --filter @opentag/opentagd dev -- init \
  --owner acme \
  --repo demo \
  --checkout /Users/example/repos/demo \
  --executor echo
```

If `OPENTAG_PAIRING_TOKEN` is set on the dispatcher, add `--pairing-token <token>` to `init` or include the same value as `pairingToken` in this file.

Do not include GitHub tokens, Slack fields, `baseBranch`, or `pushRemote` for a pure echo smoke test. Those fields belong to live callback, Slack, or PR-producing runner paths.

## Commands

Start the dispatcher:

```bash
OPENTAG_DATABASE_PATH=opentag.db pnpm --filter @opentag/dispatcher-app dev
```

Register and bind the local runner:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- register-runner
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- bind-repos
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- doctor
```

Create the sample run:

```bash
curl -X POST http://localhost:3030/v1/runs \
  -H 'content-type: application/json' \
  -d @examples/github-to-echo/run.example.json
```

Run one daemon iteration:

```bash
OPENTAG_CONFIG_PATH=opentag.local.json pnpm --filter @opentag/opentagd dev -- run-once
```

Inspect proof:

```bash
curl http://localhost:3030/v1/runs/run_demo_1
curl http://localhost:3030/v1/runs/run_demo_1/events
```

## Success Criteria

- `register-runner` prints the runner id.
- `bind-repos` prints the mapped repository and checkout.
- `doctor` reports `OK` for dispatcher health, runner registration, checkout, executor, and repo binding.
- `POST /v1/runs` returns a created run.
- `run-once` prints `OpenTag run completed`.
- `/events` contains acknowledgement, running/progress, and completion events.
