#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${OPENTAG_ENV_FILE:=$ROOT_DIR/.env.slack-test}"
: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3033}"
: "${OPENTAG_RUNNER_ID:=runner_slack_claude_real}"
: "${OPENTAG_SLACK_APPLY_PR_ACTION:=false}"

if [[ -f "$OPENTAG_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$OPENTAG_ENV_FILE"
  set +a
fi

: "${OPENTAG_SLACK_BOT_TOKEN:?Set OPENTAG_SLACK_BOT_TOKEN or OPENTAG_ENV_FILE}"
: "${OPENTAG_CONFIG_PATH:?Set OPENTAG_CONFIG_PATH or OPENTAG_ENV_FILE}"
PREPARE_PR_BRANCH="${OPENTAG_SLACK_PREPARE_PR_BRANCH:-${OPENTAG_PREPARE_PR_BRANCH:-false}}"
GITHUB_TOKEN="${OPENTAG_GITHUB_TOKEN:-}"
if [[ "$OPENTAG_SLACK_APPLY_PR_ACTION" == "true" && "$PREPARE_PR_BRANCH" != "true" ]]; then
  PREPARE_PR_BRANCH=true
fi

if [[ "$PREPARE_PR_BRANCH" == "true" || "$OPENTAG_SLACK_APPLY_PR_ACTION" == "true" ]]; then
  if [[ -z "$GITHUB_TOKEN" ]]; then
    if ! command -v gh >/dev/null 2>&1; then
      echo "Set OPENTAG_GITHUB_TOKEN or install/authenticate GitHub CLI before enabling Slack PR apply." >&2
      exit 1
    fi
    GITHUB_TOKEN="$(gh auth token)"
  fi
fi

cd "$ROOT_DIR"

CONFIG_SUMMARY="$(python3 - <<'PY'
import json, os
with open(os.environ["OPENTAG_CONFIG_PATH"]) as f:
    cfg = json.load(f)
repo = cfg["repositories"][0]
slack = cfg["slackChannels"][0]
print(json.dumps({
    "owner": repo["owner"],
    "repo": repo["repo"],
    "teamId": slack["teamId"],
    "channelId": slack["channelId"],
}))
PY
)"

OWNER="$(node -e "console.log(JSON.parse(process.argv[1]).owner)" "$CONFIG_SUMMARY")"
REPO="$(node -e "console.log(JSON.parse(process.argv[1]).repo)" "$CONFIG_SUMMARY")"
TEAM_ID="$(node -e "console.log(JSON.parse(process.argv[1]).teamId)" "$CONFIG_SUMMARY")"
CHANNEL_ID="$(node -e "console.log(JSON.parse(process.argv[1]).channelId)" "$CONFIG_SUMMARY")"
export OWNER REPO TEAM_ID CHANNEL_ID

TMP_ROOT="$(mktemp -d /tmp/opentag-slack-claude.XXXXXX)"
CHECKOUT_PATH="${OPENTAG_WORKSPACE_PATH:-$TMP_ROOT/$REPO}"
CONFIG_PATH="$(mktemp /tmp/opentag-slack-claude-config.XXXXXX)"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$TMP_ROOT/opentag-slack-claude.db}"
GITHUB_TOKEN_CONFIG=""
if [[ -n "$GITHUB_TOKEN" ]]; then
  GITHUB_TOKEN_CONFIG=$(printf '  "githubToken": "%s",\n' "$GITHUB_TOKEN")
fi

if [[ ! -d "$CHECKOUT_PATH/.git" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI not found. Set OPENTAG_WORKSPACE_PATH to an existing checkout, or install/authenticate GitHub CLI for cloning." >&2
    exit 1
  fi
  gh repo clone "$OWNER/$REPO" "$CHECKOUT_PATH" >/dev/null
fi

cat > "$CONFIG_PATH" <<JSON
{
  "runnerId": "${OPENTAG_RUNNER_ID}",
  "dispatcherUrl": "http://localhost:${OPENTAG_DISPATCHER_PORT}",
  "pairingToken": "${OPENTAG_PAIRING_TOKEN}",
${GITHUB_TOKEN_CONFIG}  "preparePullRequestBranch": ${PREPARE_PR_BRANCH},
  "pollIntervalMs": 1000,
  "heartbeatIntervalMs": 15000,
  "repositories": [
    {
      "provider": "github",
      "owner": "${OWNER}",
      "repo": "${REPO}",
      "checkoutPath": "${CHECKOUT_PATH}",
      "defaultExecutor": "claude-code",
      "baseBranch": "${OPENTAG_BASE_BRANCH:-main}",
      "pushRemote": "${OPENTAG_PUSH_REMOTE:-origin}"
    }
  ],
  "slackChannels": [
    {
      "teamId": "${TEAM_ID}",
      "channelId": "${CHANNEL_ID}",
      "owner": "${OWNER}",
      "repo": "${REPO}"
    }
  ]
}
JSON

cleanup() {
  rm -f "$CONFIG_PATH"
  kill "$DISPATCHER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for pid in $(lsof -ti "tcp:${OPENTAG_DISPATCHER_PORT}" 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done

echo "Starting dispatcher on :${OPENTAG_DISPATCHER_PORT}"
(
  export PORT="$OPENTAG_DISPATCHER_PORT"
  export OPENTAG_DATABASE_PATH="$DATABASE_PATH"
  export OPENTAG_PAIRING_TOKEN
  export OPENTAG_SLACK_BOT_TOKEN
  if [[ -n "$GITHUB_TOKEN" ]]; then
    export OPENTAG_GITHUB_TOKEN="$GITHUB_TOKEN"
  fi
  NODE_OPTIONS='--conditions=development' apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
) &
DISPATCHER_PID=$!
sleep 2

export OPENTAG_CONFIG_PATH="$CONFIG_PATH"
export OPENTAG_DISPATCHER_URL="http://localhost:${OPENTAG_DISPATCHER_PORT}"
export OPENTAG_DISPATCHER_TOKEN="$OPENTAG_PAIRING_TOKEN"
export OPENTAG_SLACK_APPLY_PR_ACTION
export PREPARE_PR_BRANCH

NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner
NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos
NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-slack-channels

SEED_JSON="$(python3 - <<'PY'
import json, os, urllib.request
text = os.environ.get("OPENTAG_SLACK_TEST_TEXT", "OpenTag Slack + Claude Code E2E test: validate real callback and metrics.")
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps({"channel": os.environ["CHANNEL_ID"], "text": text}).encode(),
    headers={"Authorization": "Bearer " + os.environ["OPENTAG_SLACK_BOT_TOKEN"], "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as resp:
    body = json.loads(resp.read())
if not body.get("ok"):
    raise SystemExit(body)
print(json.dumps({"channel": body["channel"], "ts": body["ts"]}))
PY
)"
echo "$SEED_JSON"

RUN_ID="run_slack_claude_real_$(date +%s)"
THREAD_TS="$(node -e "console.log(JSON.parse(process.argv[1]).ts)" "$SEED_JSON")"
export RUN_ID THREAD_TS

python3 - <<'PY'
import json, os, urllib.request
from datetime import datetime, timezone

run_id = os.environ["RUN_ID"]
thread_ts = os.environ["THREAD_TS"]
body = {
    "runId": run_id,
    "event": {
        "id": f"evt_{run_id}",
        "source": "slack",
        "sourceEventId": f"slack_real_{thread_ts}",
        "receivedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "actor": {"provider": "slack", "providerUserId": "U_LOCAL", "handle": "U_LOCAL", "organizationId": os.environ["TEAM_ID"]},
        "target": {"mention": "<@opentag>", "agentId": "opentag", "executorHint": "claude-code"},
        "command": {
            "rawText": os.environ.get(
                "OPENTAG_SLACK_TEST_COMMAND",
                "Add one short sentence to README.md saying Slack can trigger local Claude Code through OpenTag. Keep the change small and do not modify anything else.",
            ),
            "intent": "run",
            "args": {},
        },
        "context": [
            {"provider": "slack", "kind": "message", "uri": f"slack://team/{os.environ['TEAM_ID']}/channel/{os.environ['CHANNEL_ID']}/message/{thread_ts}", "visibility": "organization"},
            {"kind": "text", "uri": "OpenTag Slack + Claude Code E2E test: validate real callback and metrics.", "visibility": "organization"},
        ],
        "permissions": [
            {"scope": "chat:postMessage", "reason": "reply in Slack thread"},
            {"scope": "runner:local", "reason": "execute on local daemon"},
            {"scope": "repo:read", "reason": "inspect mapped repository"},
            {"scope": "repo:write", "reason": "modify local branch"},
            *([{"scope": "pr:create", "reason": "open a pull request after source-thread approval"}] if os.environ.get("PREPARE_PR_BRANCH") == "true" or os.environ.get("OPENTAG_SLACK_APPLY_PR_ACTION") == "true" else []),
        ],
        "callback": {"provider": "slack", "uri": "https://slack.com/api/chat.postMessage", "threadKey": f"{os.environ['TEAM_ID']}|{os.environ['CHANNEL_ID']}|{thread_ts}"},
        "metadata": {"teamId": os.environ["TEAM_ID"], "channelId": os.environ["CHANNEL_ID"], "messageTs": thread_ts, "repoProvider": "github", "owner": os.environ["OWNER"], "repo": os.environ["REPO"]},
    },
}
req = urllib.request.Request(
    os.environ["OPENTAG_DISPATCHER_URL"] + "/v1/runs",
    data=json.dumps(body).encode(),
    headers={"Authorization": "Bearer " + os.environ["OPENTAG_DISPATCHER_TOKEN"], "Content-Type": "application/json"},
)
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req) as resp:
    print(json.dumps({"runId": run_id, "status": resp.status}))
PY

NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts run-once

if [[ "$OPENTAG_SLACK_APPLY_PR_ACTION" == "true" ]]; then
  echo "Applying suggested PR action from the Slack source thread"
  python3 - <<'PY'
import json, os, urllib.request
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps({"channel": os.environ["CHANNEL_ID"], "thread_ts": os.environ["THREAD_TS"], "text": "apply 1"}).encode(),
    headers={"Authorization": "Bearer " + os.environ["OPENTAG_SLACK_BOT_TOKEN"], "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as resp:
    body = json.loads(resp.read())
if not body.get("ok"):
    raise SystemExit(body)
print(json.dumps({"applyMessageTs": body["ts"]}))
PY
  node <<'NODE'
const body = {
  rawText: "apply 1",
  actor: {
    provider: "slack",
    providerUserId: process.env.OPENTAG_SLACK_ACTOR_USER_ID ?? "U_LOCAL",
    handle: process.env.OPENTAG_SLACK_ACTOR_USER_ID ?? "U_LOCAL",
    organizationId: process.env.TEAM_ID
  },
  callback: {
    provider: "slack",
    uri: "https://slack.com/api/chat.postMessage",
    threadKey: `${process.env.TEAM_ID}|${process.env.CHANNEL_ID}|${process.env.THREAD_TS}`
  },
  metadata: {
    source: "slack-api-assisted-smoke",
    teamId: process.env.TEAM_ID,
    channelId: process.env.CHANNEL_ID,
    messageTs: process.env.THREAD_TS,
    repoProvider: "github",
    owner: process.env.OWNER,
    repo: process.env.REPO,
    runId: process.env.RUN_ID
  }
};

fetch(`${process.env.OPENTAG_DISPATCHER_URL}/v1/thread-actions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${process.env.OPENTAG_DISPATCHER_TOKEN}`
  },
  body: JSON.stringify(body)
}).then(async (response) => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`thread action failed: ${response.status} ${text}`);
  }
  console.log(text);
});
NODE
fi

echo "Metrics:"
curl -s -H "authorization: Bearer $OPENTAG_DISPATCHER_TOKEN" "$OPENTAG_DISPATCHER_URL/v1/runs/$RUN_ID/metrics"
echo

echo "Slack thread replies:"
python3 - <<'PY'
import json, os, urllib.parse, urllib.request
url = "https://slack.com/api/conversations.replies?" + urllib.parse.urlencode({"channel": os.environ["CHANNEL_ID"], "ts": os.environ["THREAD_TS"]})
req = urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["OPENTAG_SLACK_BOT_TOKEN"]})
with urllib.request.urlopen(req) as resp:
    body = json.loads(resp.read())
if not body.get("ok"):
    raise SystemExit(body)
print(json.dumps([{"ts": m.get("ts"), "text": m.get("text"), "blocks": bool(m.get("blocks"))} for m in body.get("messages", [])], ensure_ascii=False))
PY

echo
echo "Slack + Claude Code local test completed."
echo "- Run ID: ${RUN_ID}"
echo "- Workspace: ${CHECKOUT_PATH}"
echo "- Dispatcher DB: ${DATABASE_PATH}"
