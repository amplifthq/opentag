#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Script failed at line $LINENO." >&2' ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Run a real Slack UI-triggered OpenTag dogfood session.

This starts the local dispatcher, daemon, Slack ingress, and an optional macOS
screen recording. When OPENTAG_SLACK_APP_TOKEN is set, Slack uses Socket Mode
and no public URL is required. Otherwise, the script starts Slack Events API
ingress and ngrok. After the stack is ready, mention the Slack bot in the real
Slack UI. The script then watches the local dispatcher DB for the run that
Slack created, waits for completion, and optionally waits for a Slack Block Kit
approval/rejection button click.

Required env, usually via .env.slack-test:
  OPENTAG_CONFIG_PATH          Local OpenTag daemon config with slackChannels.
  OPENTAG_SLACK_BOT_TOKEN      Slack bot token.

Helpful env:
  OPENTAG_SLACK_APP_TOKEN      Slack app-level token. Enables Socket Mode and
                               avoids ngrok / Slack Request URL setup.
  SLACK_SIGNING_SECRET         Slack App signing secret, required only for
                               Events API mode.
  OPENTAG_UI_TRIGGER_SLACK_MODE
                               socket_mode or events_api. Defaults to
                               socket_mode when OPENTAG_SLACK_APP_TOKEN is set,
                               otherwise events_api.
  OPENTAG_SLACK_PUBLIC_URL     Fixed ngrok URL already saved in Slack, for
                               example https://example.ngrok-free.app. Events
                               API mode only.
  OPENTAG_UI_TRIGGER_COMMAND   Prompt to send after the @bot mention.
  OPENTAG_UI_TRIGGER_RECORD    true/false, default true on macOS.
  OPENTAG_UI_TRIGGER_WAIT_FOR_ACTION
                               true/false, default true.
  OPENTAG_UI_TRIGGER_ENABLE_GITHUB_APPLY
                               true/false, default true. When true, the script
                               uses OPENTAG_GITHUB_TOKEN or gh auth token so
                               Apply 1 can create the PR directly.
  OPENTAG_UI_TRIGGER_REQUIRE_APPLY_EXECUTION
                               true/false, defaults to
                               OPENTAG_UI_TRIGGER_ENABLE_GITHUB_APPLY. When true,
                               Apply actions must finish external GitHub writes
                               before the local stack is stopped.

Example:
  OPENTAG_SLACK_PUBLIC_URL=https://example.ngrok-free.app \
    scripts/dev/run-slack-ui-trigger-local-test.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

: "${OPENTAG_ENV_FILE:=$ROOT_DIR/.env.slack-test}"
: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3031}"
: "${OPENTAG_SLACK_PORT:=3040}"
: "${OPENTAG_RUNNER_ID:=runner_slack_ui_manual}"
: "${OPENTAG_UI_TRIGGER_START_NGROK:=true}"
: "${OPENTAG_UI_TRIGGER_RECORD:=true}"
: "${OPENTAG_UI_TRIGGER_WAIT_FOR_ACTION:=true}"
: "${OPENTAG_UI_TRIGGER_ENABLE_GITHUB_APPLY:=true}"
: "${OPENTAG_UI_TRIGGER_RUN_TIMEOUT_SECONDS:=900}"
: "${OPENTAG_UI_TRIGGER_ACTION_TIMEOUT_SECONDS:=600}"
: "${OPENTAG_UI_TRIGGER_RECORD_SECONDS:=600}"
: "${OPENTAG_UI_TRIGGER_MENTION_LABEL:=@open_tag}"
: "${OPENTAG_UI_TRIGGER_COMMAND:=Add one short sentence to README.md saying Slack can trigger local Claude Code through OpenTag. Keep the change small and do not modify anything else.}"

if [[ -f "$OPENTAG_ENV_FILE" ]]; then
  echo "Loading env file: $OPENTAG_ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$OPENTAG_ENV_FILE"
  set +a
fi

: "${OPENTAG_CONFIG_PATH:?Set OPENTAG_CONFIG_PATH or OPENTAG_ENV_FILE}"
: "${OPENTAG_SLACK_BOT_TOKEN:?Set OPENTAG_SLACK_BOT_TOKEN or OPENTAG_ENV_FILE}"

SLACK_MODE="${OPENTAG_UI_TRIGGER_SLACK_MODE:-${OPENTAG_SLACK_MODE:-}}"
if [[ -z "$SLACK_MODE" ]]; then
  if [[ -n "${OPENTAG_SLACK_APP_TOKEN:-${SLACK_APP_TOKEN:-}}" ]]; then
    SLACK_MODE="socket_mode"
  else
    SLACK_MODE="events_api"
  fi
fi
case "$SLACK_MODE" in
  socket_mode|events_api) ;;
  *)
    echo "OPENTAG_UI_TRIGGER_SLACK_MODE must be socket_mode or events_api, received: $SLACK_MODE" >&2
    exit 1
    ;;
esac
if [[ "$SLACK_MODE" == "socket_mode" ]]; then
  : "${OPENTAG_SLACK_APP_TOKEN:=${SLACK_APP_TOKEN:-}}"
  : "${OPENTAG_SLACK_APP_TOKEN:?Set OPENTAG_SLACK_APP_TOKEN for Socket Mode, or set OPENTAG_UI_TRIGGER_SLACK_MODE=events_api}"
else
  : "${SLACK_SIGNING_SECRET:?Set SLACK_SIGNING_SECRET for Events API mode, or set OPENTAG_SLACK_APP_TOKEN for Socket Mode}"
fi

cd "$ROOT_DIR"
echo "Using OpenTag repo: $ROOT_DIR"
echo "Slack ingress mode: $SLACK_MODE"

DISPATCHER_PID=""
DAEMON_PID=""
SLACK_PID=""
NGROK_PID=""
RECORDER_PID=""
TMP_ROOT=""
CONFIG_PATH=""
DATABASE_PATH=""
NGROK_LOG=""
RECORDING_PATH=""

bool_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

screen_is_locked() {
  if ! command -v ioreg >/dev/null 2>&1; then
    return 1
  fi
  local session_state
  session_state="$(ioreg -n Root -d1 2>/dev/null)" || return 1
  grep -q 'CGSSessionScreenIsLocked.*Yes' <<<"$session_state"
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sqlite_one() {
  sqlite3 -cmd ".timeout 5000" -noheader "$DATABASE_PATH" "$1" 2>/dev/null || true
}

kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ -n "$RECORDER_PID" ]] && kill -0 "$RECORDER_PID" 2>/dev/null; then
    echo
    echo "Stopping screen recording..."
    kill -INT "$RECORDER_PID" 2>/dev/null || true
    wait "$RECORDER_PID" 2>/dev/null || true
  fi

  kill_pid "$SLACK_PID"
  kill_pid "$DAEMON_PID"
  kill_pid "$DISPATCHER_PID"
  kill_pid "$NGROK_PID"

  if [[ -n "$CONFIG_PATH" ]]; then
    rm -f "$CONFIG_PATH"
  fi

  if [[ -n "$TMP_ROOT" ]]; then
    echo "Preserved temp root: $TMP_ROOT"
  fi
  if [[ -n "$DATABASE_PATH" ]]; then
    echo "Dispatcher DB: $DATABASE_PATH"
  fi
  if [[ -n "$RECORDING_PATH" && -f "$RECORDING_PATH" ]]; then
    echo "Screen recording: $RECORDING_PATH"
  fi

  exit "$status"
}
trap cleanup EXIT INT TERM

require_cmd curl
require_cmd python3
require_cmd sqlite3
require_cmd node
require_cmd lsof
echo "Required local commands are available."

if [[ "$SLACK_MODE" == "events_api" ]] && bool_true "$OPENTAG_UI_TRIGGER_START_NGROK"; then
  require_cmd ngrok
  echo "ngrok command is available."
fi
if bool_true "$OPENTAG_UI_TRIGGER_RECORD" && screen_is_locked; then
  echo "Screen recording requested, but the macOS session is locked." >&2
  echo "Unlock the screen and keep Slack visible before rerunning the README recording flow." >&2
  exit 1
fi

ensure_port_free() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  if bool_true "${OPENTAG_UI_TRIGGER_KILL_PORTS:-false}"; then
    echo "Killing existing $label process(es) on :$port: $pids"
    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
    return 0
  fi

  echo "Port :$port is already in use by: $pids" >&2
  echo "Stop that process or rerun with OPENTAG_UI_TRIGGER_KILL_PORTS=true." >&2
  exit 1
}

wait_for_dispatcher() {
  local url="$1"
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if curl -fsS "$url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Dispatcher did not become healthy at $url/healthz." >&2
  exit 1
}

wait_for_ngrok_url() {
  local deadline=$((SECONDS + 45))
  local url=""
  while (( SECONDS < deadline )); do
    url="$(
      python3 - <<'PY' 2>/dev/null || true
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
    payload = json.loads(resp.read())
for tunnel in payload.get("tunnels", []):
    public_url = tunnel.get("public_url", "")
    if public_url.startswith("https://"):
        print(public_url.rstrip("/"))
        break
PY
    )"
    if [[ -n "$url" ]]; then
      printf "%s" "$url"
      return 0
    fi
    sleep 1
  done

  echo "ngrok did not expose an HTTPS tunnel." >&2
  if [[ -n "$NGROK_LOG" && -f "$NGROK_LOG" ]]; then
    echo "ngrok log:" >&2
    tail -n 80 "$NGROK_LOG" >&2 || true
  fi
  exit 1
}

get_ngrok_url_once() {
  python3 - <<'PY' 2>/dev/null || true
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
    payload = json.loads(resp.read())
for tunnel in payload.get("tunnels", []):
    public_url = tunnel.get("public_url", "")
    if public_url.startswith("https://"):
        print(public_url.rstrip("/"))
        break
PY
}

public_ingress_probe() {
  local public_url="$1"
  local code
  local probe_body
  if [[ -n "$TMP_ROOT" ]]; then
    probe_body="$TMP_ROOT/slack-ingress-probe.json"
  else
    probe_body="$(mktemp /tmp/opentag-slack-ui-trigger-probe.XXXXXX)"
  fi
  code="$(curl -sS -o "$probe_body" -w "%{http_code}" -X POST "$public_url/slack/events" -H "content-type: application/json" --data '{}' || true)"
  if [[ "$code" == "401" ]]; then
    echo "Public Slack ingress probe reached OpenTag (401 without Slack signature is expected)."
    return 0
  fi
  echo "Warning: public ingress probe returned HTTP $code, expected 401." >&2
  echo "Check that Slack Event Subscriptions and Interactivity point to: $public_url/slack/events" >&2
  exit 1
}

fetch_slack_bot_identity() {
  python3 - <<'PY' 2>/dev/null || true
import json
import os
import urllib.request

req = urllib.request.Request(
    "https://slack.com/api/auth.test",
    headers={"Authorization": "Bearer " + os.environ["OPENTAG_SLACK_BOT_TOKEN"]},
)
with urllib.request.urlopen(req, timeout=10) as resp:
    body = json.loads(resp.read())
if body.get("ok"):
    print(body.get("user_id", ""))
PY
}

print_slack_thread() {
  local channel_id="$1"
  local thread_ts="$2"
  if [[ -z "$channel_id" || -z "$thread_ts" ]]; then
    return 0
  fi
  python3 - "$channel_id" "$thread_ts" <<'PY' || true
import json
import os
import sys
import urllib.parse
import urllib.request

channel_id = sys.argv[1]
thread_ts = sys.argv[2]
query = urllib.parse.urlencode({"channel": channel_id, "ts": thread_ts, "limit": 30})
req = urllib.request.Request(
    "https://slack.com/api/conversations.replies?" + query,
    headers={"Authorization": "Bearer " + os.environ["OPENTAG_SLACK_BOT_TOKEN"]},
)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read())
except Exception as exc:
    print(f"Could not fetch Slack thread: {exc}")
    raise SystemExit(0)
if not body.get("ok"):
    print("Could not fetch Slack thread:", body.get("error", body))
    raise SystemExit(0)

messages = body.get("messages", [])
print(f"Slack thread messages: {len(messages)}")
for message in messages[-8:]:
    sender = message.get("user") or message.get("bot_id") or message.get("username") or "unknown"
    text = (message.get("text") or "").replace("\n", " ")
    if len(text) > 220:
        text = text[:217] + "..."
    print(f"- {message.get('ts', '')} {sender}: {text}")
PY
}

print_metrics() {
  local run_id="$1"
  local payload
  payload="$(curl -fsS -H "authorization: Bearer $OPENTAG_PAIRING_TOKEN" "http://localhost:${OPENTAG_DISPATCHER_PORT}/v1/runs/${run_id}/metrics" || true)"
  if [[ -z "$payload" ]]; then
    echo "Could not fetch run metrics."
    return 0
  fi
  python3 - "$payload" <<'PY' || true
import json
import sys

payload = json.loads(sys.argv[1])
metrics = payload.get("metrics", {})
summary = {
    "humanCallbackCount": metrics.get("humanCallbackCount"),
    "suggestedChangesCount": metrics.get("suggestedChangesCount"),
    "approvalDecisionCount": metrics.get("approvalDecisionCount"),
    "threadNoiseRatio": metrics.get("threadNoiseRatio"),
    "childRunCount": metrics.get("childRunCount"),
}
print("Run metrics:", json.dumps(summary, sort_keys=True))
PY
}

print_latest_apply_plan() {
  local decision_id="$1"
  if [[ -z "$decision_id" ]]; then
    return 0
  fi
  local plan_json
  plan_json="$(sqlite_one "select plan_json from apply_plans where approval_decision_id = '$(sql_escape "$decision_id")' order by created_at desc limit 1;")"
  if [[ -z "$plan_json" ]]; then
    return 0
  fi
  python3 - "$plan_json" <<'PY' || true
import json
import sys

plan = json.loads(sys.argv[1])
outcomes = [
    {
        "intentId": outcome.get("intentId"),
        "outcome": outcome.get("outcome"),
        **({"externalUri": outcome.get("externalUri")} if outcome.get("externalUri") else {}),
        **({"message": outcome.get("message")} if outcome.get("message") else {}),
    }
    for outcome in plan.get("outcomes", [])
]
print("Latest apply plan:", json.dumps({
    "id": plan.get("id"),
    "externalWritesExecuted": plan.get("adapterPlan", {}).get("externalWritesExecuted"),
    "outcomes": outcomes,
}, sort_keys=True))
PY
}

apply_plan_external_writes_executed() {
  local decision_id="$1"
  local count
  count="$(
    sqlite_one "select count(*) from apply_plans where approval_decision_id = '$(sql_escape "$decision_id")' and json_extract(plan_json, '$.adapterPlan.externalWritesExecuted') = 1;"
  )"
  [[ "${count:-0}" -gt 0 ]]
}

callback_delivered_after_action() {
  local run_id="$1"
  local before_callback_count="$2"
  local after_callback_count
  after_callback_count="$(sqlite_one "select count(*) from callback_deliveries where run_id = '$(sql_escape "$run_id")';")"
  [[ -n "$after_callback_count" && -n "$before_callback_count" && "$after_callback_count" -gt "$before_callback_count" ]]
}

eval "$(
  python3 - <<'PY'
import json
import os
import shlex

with open(os.environ["OPENTAG_CONFIG_PATH"], "r", encoding="utf-8") as f:
    cfg = json.load(f)

bindings = []
for binding in cfg.get("slackChannels", []) or []:
    bindings.append({
        "teamId": binding["teamId"],
        "channelId": binding["channelId"],
        "repoProvider": binding.get("repoProvider", "github"),
        "owner": binding["owner"],
        "repo": binding["repo"],
    })
for binding in cfg.get("channelBindings", []) or []:
    if binding.get("provider") == "slack":
        bindings.append({
            "teamId": binding["accountId"],
            "channelId": binding["conversationId"],
            "repoProvider": binding.get("repoProvider", "github"),
            "owner": binding["owner"],
            "repo": binding["repo"],
        })

if not bindings:
    raise SystemExit("Config has no slackChannels or slack channelBindings.")

target_channel = os.environ.get("OPENTAG_SLACK_CHANNEL_ID")
if target_channel:
    matches = [binding for binding in bindings if binding["channelId"] == target_channel]
    if not matches:
        raise SystemExit(f"No Slack channel binding found for OPENTAG_SLACK_CHANNEL_ID={target_channel}.")
    binding = matches[0]
else:
    binding = bindings[0]

repos = cfg.get("repositories", []) or []
matching_repos = [
    repo for repo in repos
    if repo.get("provider", "github") == binding["repoProvider"]
    and repo.get("owner") == binding["owner"]
    and repo.get("repo") == binding["repo"]
]
repo = matching_repos[0] if matching_repos else {}

summary = {
    **binding,
    "baseBranch": repo.get("baseBranch") or "main",
    "pushRemote": repo.get("pushRemote") or "origin",
}

for env_name, key in [
    ("OWNER", "owner"),
    ("REPO", "repo"),
    ("REPO_PROVIDER", "repoProvider"),
    ("TEAM_ID", "teamId"),
    ("CHANNEL_ID", "channelId"),
    ("BASE_BRANCH", "baseBranch"),
    ("PUSH_REMOTE", "pushRemote"),
]:
    print(f"{env_name}={shlex.quote(str(summary[key]))}")
PY
)"
export OWNER REPO REPO_PROVIDER TEAM_ID CHANNEL_ID BASE_BRANCH PUSH_REMOTE

TMP_ROOT="$(mktemp -d /tmp/opentag-slack-ui-trigger.XXXXXX)"
CONFIG_PATH="$TMP_ROOT/opentag-slack-ui-trigger.config.json"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$TMP_ROOT/opentag-slack-ui-trigger.db}"
CHECKOUT_PATH="${OPENTAG_WORKSPACE_PATH:-$TMP_ROOT/$REPO}"
NGROK_LOG="$TMP_ROOT/ngrok.log"

if [[ ! -d "$CHECKOUT_PATH/.git" ]]; then
  require_cmd gh
  echo "Cloning $OWNER/$REPO into temporary checkout..."
  gh repo clone "$OWNER/$REPO" "$CHECKOUT_PATH" >/dev/null
fi

if [[ -n "$(git -C "$CHECKOUT_PATH" status --porcelain)" ]]; then
  echo "Checkout is dirty: $CHECKOUT_PATH" >&2
  echo "Use a clean OPENTAG_WORKSPACE_PATH or let the script create a temp checkout." >&2
  exit 1
fi

PREPARE_PR_BRANCH="${OPENTAG_SLACK_PREPARE_PR_BRANCH:-${OPENTAG_PREPARE_PR_BRANCH:-false}}"
GITHUB_TOKEN="${OPENTAG_GITHUB_TOKEN:-}"
EFFECTIVE_GITHUB_APPLY=false
if bool_true "$OPENTAG_UI_TRIGGER_ENABLE_GITHUB_APPLY"; then
  if [[ -z "$GITHUB_TOKEN" ]] && command -v gh >/dev/null 2>&1; then
    GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  if [[ -n "$GITHUB_TOKEN" ]]; then
    PREPARE_PR_BRANCH=true
    EFFECTIVE_GITHUB_APPLY=true
    echo "GitHub apply is enabled; runner will prepare a pushed PR branch."
  else
    echo "GitHub apply is disabled because no token is available; direct-apply actions should render as Needs setup/Continue."
  fi
elif [[ "$PREPARE_PR_BRANCH" == "true" && -z "$GITHUB_TOKEN" ]]; then
  require_cmd gh
  GITHUB_TOKEN="$(gh auth token)"
fi
if [[ -n "$GITHUB_TOKEN" && "$PREPARE_PR_BRANCH" == "true" ]]; then
  EFFECTIVE_GITHUB_APPLY=true
fi
export CHECKOUT_PATH CONFIG_PATH DATABASE_PATH PREPARE_PR_BRANCH GITHUB_TOKEN EFFECTIVE_GITHUB_APPLY
export OPENTAG_RUNNER_ID OPENTAG_DISPATCHER_PORT OPENTAG_PAIRING_TOKEN

python3 - <<'PY'
import json
import os

config = {
    "runnerId": os.environ["OPENTAG_RUNNER_ID"],
    "dispatcherUrl": f"http://localhost:{os.environ['OPENTAG_DISPATCHER_PORT']}",
    "pairingToken": os.environ["OPENTAG_PAIRING_TOKEN"],
    "preparePullRequestBranch": os.environ.get("PREPARE_PR_BRANCH", "false").lower() == "true",
    "pollIntervalMs": 1000,
    "heartbeatIntervalMs": 15000,
    "repositories": [
        {
            "provider": os.environ["REPO_PROVIDER"],
            "owner": os.environ["OWNER"],
            "repo": os.environ["REPO"],
            "checkoutPath": os.environ["CHECKOUT_PATH"],
            "defaultExecutor": "claude-code",
            "baseBranch": os.environ["BASE_BRANCH"],
            "pushRemote": os.environ["PUSH_REMOTE"],
        }
    ],
    "slackChannels": [
        {
            "teamId": os.environ["TEAM_ID"],
            "channelId": os.environ["CHANNEL_ID"],
            "repoProvider": os.environ["REPO_PROVIDER"],
            "owner": os.environ["OWNER"],
            "repo": os.environ["REPO"],
        }
    ],
}
if os.environ.get("GITHUB_TOKEN"):
    config["githubToken"] = os.environ["GITHUB_TOKEN"]

with open(os.environ["CONFIG_PATH"], "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PY

ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
if [[ "$SLACK_MODE" == "events_api" ]]; then
  ensure_port_free "$OPENTAG_SLACK_PORT" "Slack ingress"
fi

echo "Starting dispatcher on :${OPENTAG_DISPATCHER_PORT}"
PORT="$OPENTAG_DISPATCHER_PORT" \
OPENTAG_DATABASE_PATH="$DATABASE_PATH" \
OPENTAG_PAIRING_TOKEN="$OPENTAG_PAIRING_TOKEN" \
OPENTAG_SLACK_BOT_TOKEN="$OPENTAG_SLACK_BOT_TOKEN" \
OPENTAG_GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
NODE_OPTIONS='--conditions=development' \
apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts &
DISPATCHER_PID=$!

wait_for_dispatcher "http://localhost:${OPENTAG_DISPATCHER_PORT}"

export OPENTAG_CONFIG_PATH="$CONFIG_PATH"
export OPENTAG_DISPATCHER_URL="http://localhost:${OPENTAG_DISPATCHER_PORT}"
export OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN"

echo "Registering runner and bindings"
NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner
NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos
NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-slack-channels

echo "Starting local daemon"
OPENTAG_CONFIG_PATH="$CONFIG_PATH" \
OPENTAG_DISPATCHER_URL="http://localhost:${OPENTAG_DISPATCHER_PORT}" \
OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN" \
NODE_OPTIONS='--conditions=development' \
apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts serve &
DAEMON_PID=$!

if [[ "$SLACK_MODE" == "socket_mode" ]]; then
  echo "Starting Slack Socket Mode ingress"
  OPENTAG_SLACK_MODE="socket_mode" \
  OPENTAG_SLACK_APP_TOKEN="$OPENTAG_SLACK_APP_TOKEN" \
  OPENTAG_DISPATCHER_URL="http://localhost:${OPENTAG_DISPATCHER_PORT}" \
  OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN" \
  NODE_OPTIONS='--conditions=development' \
  apps/slack-events/node_modules/.bin/tsx apps/slack-events/src/index.ts &
else
  echo "Starting Slack Events ingress on :${OPENTAG_SLACK_PORT}"
  OPENTAG_SLACK_MODE="events_api" \
  SLACK_SIGNING_SECRET="$SLACK_SIGNING_SECRET" \
  OPENTAG_DISPATCHER_URL="http://localhost:${OPENTAG_DISPATCHER_PORT}" \
  OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN" \
  PORT="$OPENTAG_SLACK_PORT" \
  NODE_OPTIONS='--conditions=development' \
  apps/slack-events/node_modules/.bin/tsx apps/slack-events/src/index.ts &
fi
SLACK_PID=$!
sleep 2

PUBLIC_URL="${OPENTAG_SLACK_PUBLIC_URL:-}"
if [[ "$SLACK_MODE" == "events_api" ]] && bool_true "$OPENTAG_UI_TRIGGER_START_NGROK"; then
  existing_tunnel="$(get_ngrok_url_once)"
  if [[ -n "$existing_tunnel" && -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="$existing_tunnel"
    echo "Using existing ngrok tunnel: $PUBLIC_URL"
  elif [[ -n "$existing_tunnel" && -n "$PUBLIC_URL" ]]; then
    echo "Existing ngrok tunnel detected: $existing_tunnel"
    echo "Slack should still use configured URL: $PUBLIC_URL"
  else
    if [[ -n "$(lsof -ti tcp:4040 2>/dev/null || true)" ]]; then
      echo "ngrok API port :4040 is in use, but no HTTPS tunnel was found." >&2
      echo "Stop that ngrok process or set OPENTAG_SLACK_PUBLIC_URL and OPENTAG_UI_TRIGGER_START_NGROK=false." >&2
      exit 1
    fi
    echo "Starting ngrok for Slack ingress"
    if [[ -n "$PUBLIC_URL" ]]; then
      NGROK_URL="${PUBLIC_URL%/}"
      case "$NGROK_URL" in
        http://*|https://*) ;;
        *) NGROK_URL="https://$NGROK_URL" ;;
      esac
      ngrok http "$OPENTAG_SLACK_PORT" --url "$NGROK_URL" --log stdout >"$NGROK_LOG" 2>&1 &
    else
      ngrok http "$OPENTAG_SLACK_PORT" --log stdout >"$NGROK_LOG" 2>&1 &
    fi
    NGROK_PID=$!
    STARTED_NGROK_URL="$(wait_for_ngrok_url)"
    if [[ -n "$PUBLIC_URL" ]]; then
      echo "ngrok started: $STARTED_NGROK_URL"
      echo "Using configured Slack public URL: $PUBLIC_URL"
    else
      PUBLIC_URL="$STARTED_NGROK_URL"
    fi
  fi
fi

if [[ "$SLACK_MODE" == "events_api" && -z "$PUBLIC_URL" ]]; then
  echo "Set OPENTAG_SLACK_PUBLIC_URL or enable OPENTAG_UI_TRIGGER_START_NGROK=true." >&2
  exit 1
fi
if [[ -n "$PUBLIC_URL" ]]; then
  PUBLIC_URL="${PUBLIC_URL%/}"
fi

if [[ "$SLACK_MODE" == "events_api" ]]; then
  public_ingress_probe "$PUBLIC_URL"
fi

BOT_USER_ID="$(fetch_slack_bot_identity)"

if bool_true "$OPENTAG_UI_TRIGGER_RECORD" && command -v screencapture >/dev/null 2>&1; then
  mkdir -p "$ROOT_DIR/artifacts/e2e-recordings"
  RECORDING_PATH="${OPENTAG_UI_TRIGGER_RECORDING:-$ROOT_DIR/artifacts/e2e-recordings/slack-manual-ui-trigger-$(date +%Y%m%d-%H%M%S).mov}"
  echo "Starting screen recording: $RECORDING_PATH"
  screencapture -v -V "$OPENTAG_UI_TRIGGER_RECORD_SECONDS" -k "$RECORDING_PATH" >/dev/null 2>&1 &
  RECORDER_PID=$!
elif bool_true "$OPENTAG_UI_TRIGGER_RECORD"; then
  echo "screencapture not found; continuing without recording."
fi

WAIT_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
export WAIT_STARTED_AT

echo
echo "Slack UI trigger stack is ready."
if [[ "$SLACK_MODE" == "socket_mode" ]]; then
  echo "- Slack uses Socket Mode; no Request URL or ngrok tunnel is required."
  echo "- Slack Interactivity must be enabled, but Socket Mode does not need an Interactivity Request URL."
else
  echo "- Slack Request URL must be: $PUBLIC_URL/slack/events"
  echo "- Event Subscriptions and Interactivity should both use that same URL."
fi
echo "- Bound Slack channel id: $CHANNEL_ID"
echo "- Bound repository: $REPO_PROVIDER:$OWNER/$REPO"
echo "- Temporary checkout: $CHECKOUT_PATH"
echo
echo "Now go to Slack and send a new message in the bound channel:"
if [[ -n "$BOT_USER_ID" ]]; then
  echo "  <@$BOT_USER_ID> $OPENTAG_UI_TRIGGER_COMMAND"
else
  echo "  $OPENTAG_UI_TRIGGER_MENTION_LABEL $OPENTAG_UI_TRIGGER_COMMAND"
fi
echo
echo "Keep this terminal running. Waiting for the Slack-created run..."

RUN_ID=""
CHANNEL_SQL="$(sql_escape "$CHANNEL_ID")"
STARTED_SQL="$(sql_escape "$WAIT_STARTED_AT")"
deadline=$((SECONDS + OPENTAG_UI_TRIGGER_RUN_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  RUN_ID="$(
    sqlite_one "select id from runs where json_extract(event_json, '$.source') = 'slack' and json_extract(event_json, '$.metadata.channelId') = '$CHANNEL_SQL' and created_at >= '$STARTED_SQL' order by created_at desc limit 1;"
  )"
  if [[ -n "$RUN_ID" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$RUN_ID" ]]; then
  echo "Timed out waiting for a Slack-created run." >&2
  if [[ "$SLACK_MODE" == "socket_mode" ]]; then
    echo "Check Socket Mode, app_mention subscription, bot scopes, app token, and channel invite." >&2
  else
    echo "Check Slack Request URL, app_mention subscription, signing secret, and ngrok log: $NGROK_LOG" >&2
  fi
  exit 1
fi

echo "Detected Slack-created run: $RUN_ID"
THREAD_KEY="$(sqlite_one "select json_extract(event_json, '$.callback.threadKey') from runs where id = '$(sql_escape "$RUN_ID")';")"
THREAD_TS="${THREAD_KEY##*|}"
echo "Slack thread key: $THREAD_KEY"

last_status=""
deadline=$((SECONDS + OPENTAG_UI_TRIGGER_RUN_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  status="$(sqlite_one "select status from runs where id = '$(sql_escape "$RUN_ID")';")"
  if [[ "$status" != "$last_status" && -n "$status" ]]; then
    echo "Run status: $status"
    last_status="$status"
  fi
  case "$status" in
    succeeded|failed|cancelled|needs_approval) break ;;
  esac
  sleep 3
done

if [[ -z "${status:-}" || "$status" == "queued" || "$status" == "assigned" || "$status" == "running" ]]; then
  echo "Timed out waiting for run completion. Last status: ${status:-unknown}" >&2
  exit 1
fi

print_metrics "$RUN_ID"
print_slack_thread "$CHANNEL_ID" "$THREAD_TS"

SUGGESTED_COUNT="$(sqlite_one "select count(*) from suggested_changes where run_id = '$(sql_escape "$RUN_ID")';")"
if bool_true "$OPENTAG_UI_TRIGGER_WAIT_FOR_ACTION" && [[ "${SUGGESTED_COUNT:-0}" != "0" ]]; then
  RUN_SQL="$(sql_escape "$RUN_ID")"
  PROPOSALS_FOR_RUN_SQL="select proposal_id from suggested_changes where run_id = '$RUN_SQL'"
  before_count="$(sqlite_one "select count(*) from approval_decisions where proposal_id in ($PROPOSALS_FOR_RUN_SQL);")"
  before_callback_count="$(sqlite_one "select count(*) from callback_deliveries where run_id = '$RUN_SQL';")"
  echo
  echo "Suggested changes detected: $SUGGESTED_COUNT"
  echo "Click a Slack Block Kit action button now, for example Reject 2 or Apply 1."
  echo "Waiting for an approval_decisions row..."
  deadline=$((SECONDS + OPENTAG_UI_TRIGGER_ACTION_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    after_count="$(sqlite_one "select count(*) from approval_decisions where proposal_id in ($PROPOSALS_FOR_RUN_SQL);")"
    if [[ -n "$after_count" && -n "$before_count" && "$after_count" -gt "$before_count" ]]; then
      echo "Detected Slack button/thread action."
      break
    fi
    sleep 2
  done

  if [[ "${after_count:-0}" -le "${before_count:-0}" ]]; then
    echo "Timed out waiting for a Slack action. Leaving stack evidence below."
  else
    latest_decision="$(sqlite_one "select decision_json from approval_decisions where proposal_id in ($PROPOSALS_FOR_RUN_SQL) order by created_at desc limit 1;")"
    latest_decision_id="$(sqlite_one "select id from approval_decisions where proposal_id in ($PROPOSALS_FOR_RUN_SQL) order by created_at desc limit 1;")"
    latest_raw_text="$(sqlite_one "select coalesce(json_extract(decision_json, '$.metadata.rawText'), '') from approval_decisions where proposal_id in ($PROPOSALS_FOR_RUN_SQL) order by created_at desc limit 1;")"
    python3 - "$latest_decision" <<'PY' || true
import json
import sys

raw = sys.argv[1].strip()
if not raw:
    raise SystemExit(0)
decision = json.loads(raw)
metadata = decision.get("metadata", {})
print("Latest approval decision:", json.dumps({
    "rawText": metadata.get("rawText") or decision.get("command", {}).get("rawText"),
    "source": metadata.get("source") or metadata.get("ingressMetadata", {}).get("source"),
    "actionId": metadata.get("actionId") or metadata.get("ingressMetadata", {}).get("actionId"),
    "proposalId": decision.get("proposalId"),
}, sort_keys=True))
PY
    echo "Waiting for dispatcher to finish the approved action..."
    require_apply_execution="${OPENTAG_UI_TRIGGER_REQUIRE_APPLY_EXECUTION:-$EFFECTIVE_GITHUB_APPLY}"
    action_deadline=$((SECONDS + OPENTAG_UI_TRIGGER_ACTION_TIMEOUT_SECONDS))
    action_finished=false
    while (( SECONDS < action_deadline )); do
      callback_done=false
      apply_done=false

      if callback_delivered_after_action "$RUN_ID" "$before_callback_count"; then
        callback_done=true
      fi

      if [[ "$latest_raw_text" == [Aa]pply* ]] && bool_true "$require_apply_execution"; then
        if apply_plan_external_writes_executed "$latest_decision_id"; then
          apply_done=true
        fi
      else
        apply_done=true
      fi

      if [[ "$callback_done" == "true" && "$apply_done" == "true" ]]; then
        action_finished=true
        break
      fi
      sleep 2
    done

    if [[ "$action_finished" == "true" ]]; then
      echo "Approved action finished."
    else
      echo "Timed out waiting for the approved action to finish. Leaving stack evidence below."
    fi
    print_latest_apply_plan "$latest_decision_id"
  fi

  print_metrics "$RUN_ID"
  print_slack_thread "$CHANNEL_ID" "$THREAD_TS"
fi

echo
echo "Slack UI-triggered dogfood session finished."
