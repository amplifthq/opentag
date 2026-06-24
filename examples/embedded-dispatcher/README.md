# Embedded Dispatcher Example

This example shows how another Node service can embed OpenTag's dispatcher package instead of running `@opentag/dispatcher-app` as a separate process.

It mounts the dispatcher under `/opentag/*` and adds a tiny custom webhook at `/custom/mention` that creates an OpenTag run through `@opentag/client`.

## Run

```bash
pnpm install
OPENTAG_DATABASE_PATH=opentag.embedded.db \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
pnpm --filter @opentag/example-embedded-dispatcher dev
```

## Create a Runner Binding

The embedded dispatcher still uses the normal dispatcher API:

```bash
curl -X POST http://localhost:3050/opentag/v1/runners \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev_pairing_token' \
  -d '{"runnerId":"runner_local","name":"Local Runner"}'

curl -X POST http://localhost:3050/opentag/v1/repo-bindings \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev_pairing_token' \
  -d '{"provider":"github","owner":"acme","repo":"demo","runnerId":"runner_local","workspacePath":"/tmp/demo","defaultExecutor":"echo"}'
```

## Create a Run Through the Host App

```bash
curl -X POST http://localhost:3050/custom/mention \
  -H 'content-type: application/json' \
  -d '{"owner":"acme","repo":"demo","actor":"octocat","text":"fix this flaky test"}'
```

The custom route creates a standard `OpenTagEvent` and sends it to the embedded dispatcher using `@opentag/client`.

## Inspect

```bash
curl -H 'authorization: Bearer dev_pairing_token' \
  http://localhost:3050/opentag/v1/runs/run_custom_1
```
