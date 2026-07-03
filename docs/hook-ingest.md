# Hook Ingest Contract

Hook ingest lets an external local agent runtime report progress and terminal
state into an OpenTag run without becoming an OpenTag plugin, hosted runtime, or
source-thread bot. It is a runner-scoped reporting contract: the external
runtime observes its own lifecycle and OpenTag records that evidence in
audit/status while provider-facing replies stay concise.

Use it when an executor is not a simple spawn wrapper but can emit lifecycle
hooks such as `post_llm_call`, `before_agent_finalize`, `agent_end`,
`agent_failed`, or `agent_timeout`.

## Boundary

- Hook ingest is local-first. It calls the configured dispatcher through the
  same local config as the daemon.
- Hook ingest does not read source-thread transcripts or raw provider payloads.
- Hook ingest does not mutate prompts, apply source-thread actions, or create
  pull requests.
- Progress is audit-visible by default; source-thread callbacks are still
  rendered by OpenTag from run state and final artifacts.
- The generated shell templates and manifest must not contain dispatcher tokens,
  local checkout paths, raw tool logs, or secrets.

## Auth And Endpoints

The CLI command `opentag ingest` reads the local config and authenticates with
the configured `runnerId`, `dispatcherUrl`, and preferred `runnerToken`. The
legacy `pairingToken` fallback is accepted for old local configs, but new
automation should use the runner-scoped token.

The CLI maps hook events onto the runner API:

| Hook intent | Dispatcher endpoint |
| --- | --- |
| Progress | `POST /v1/runners/:runnerId/runs/:runId/progress` |
| Completion, failure, cancellation, interruption, timeout | `POST /v1/runners/:runnerId/runs/:runId/complete` |

The hook wrapper should set `OPENTAG_RUN_ID` and call the local CLI rather than
embedding raw HTTP tokens in a third-party runtime config.

## Manifest

Runtimes that prefer a machine-readable contract can print:

```bash
opentag ingest-template --source hermes --format manifest
```

The manifest has `kind: "opentag_hook_ingest_manifest"` and version `1`.
It declares:

- `source`: a lowercase safe runtime label such as `hermes`, `openclaw`, or
  `custom-agent`.
- `command`: the local OpenTag command to invoke.
- `requiredEnv`: currently `OPENTAG_RUN_ID`.
- `optionalEnv`: source, command, and idempotency prefix overrides.
- `permissions`: explicit denial of conversation access, prompt mutation, raw
  context access, and source-thread write actions.
- `lifecycle`: progress visibility, final-answer gate semantics, and terminal
  event policy.
- `events`: external event names mapped to OpenTag progress or terminal result
  semantics.
- `constraints`: safety rules for idempotency, terminal events, and source
  thread quietness.

## Event Semantics

Progress aliases such as `progress`, `agent_progress`, `post_llm_call`,
`before_agent_finalize`, `tool_start`, and `tool_end` append audit-visible run
progress. They do not mean the run is complete.

Terminal aliases complete the OpenTag run:

| External event family | OpenTag conclusion |
| --- | --- |
| `agent_end`, `completed`, `complete`, `final` | `success` unless overridden by `--result-json` or `--conclusion` |
| `failed`, `failure`, `agent_failed`, `agent_error`, `error` | `failure` |
| `cancelled`, `agent_cancelled`, `stop`, `stopped` | `cancelled` |
| `interrupted`, `agent_interrupted`, `session_end`, `on_session_end` | `interrupted` |
| `timeout`, `timed_out`, `agent_timeout` | `timed_out` |

`before_agent_finalize` is deliberately progress, not success. A runtime should
report exactly one terminal event for each OpenTag run.

## Idempotency

Every retryable hook delivery should pass a stable `--idempotency-key`.
Generated templates use:

```text
$OPENTAG_INGEST_IDEMPOTENCY_PREFIX:<event-family>:<external-event>
```

Replaying the same key for the same run returns success without appending a
duplicate audit event or re-sending source-thread progress.

## Visibility And Ledger

Hook progress is recorded as audit-visible run events. Status and ledger views
can show the lifecycle evidence locally:

```bash
opentag status --run run_123
```

The source thread should only receive concise OpenTag-rendered receipts, final
summaries, artifacts, and safe next actions. Detailed hook logs belong in the
local Agent Work Ledger, not in the human collaboration thread.

## Minimal Shell Template

Print and adapt a local shell template:

```bash
opentag ingest-template --source hermes
```

Place generated calls at the runtime's lifecycle hooks, keep the script local,
and prefer SecretRefs or local environment variables for runner auth. Do not
copy local tokens or raw executor output into provider configuration or source
threads.
