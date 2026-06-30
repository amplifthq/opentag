#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Script failed at line $LINENO." >&2' ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Run a real GitHub repository-webhook OpenTag dogfood session.

This starts the local OpenTag CLI stack, exposes the GitHub webhook listener
through ngrok, creates a temporary repository webhook, posts a real GitHub issue
comment, waits for OpenTag to finish, replies `apply 1`, and waits for the
created pull request.

Required:
  gh CLI authenticated as a user with admin access to the target repository.
  claude CLI installed and logged in, unless OPENTAG_GH_LIVE_EXECUTOR is changed.
  ngrok installed when OPENTAG_GH_LIVE_START_NGROK=true.

Helpful env:
  OPENTAG_GH_REPO                 owner/repo, default amplifthq/opentag-test
  OPENTAG_GH_PUBLIC_URL           fixed public tunnel URL, if already running
  OPENTAG_GH_LIVE_COMMAND         prompt after `@opentag run`
  OPENTAG_GH_LIVE_APPLY           true/false, default true
  OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN
                                     true/false, default false. Keeps GitHub
                                     callbacks working but verifies Needs setup
                                     when direct apply is unavailable.
  OPENTAG_GH_LIVE_KEEP_WEBHOOK    true/false, default false
  OPENTAG_GH_LIVE_KILL_PORTS      true/false, default false

Example:
  OPENTAG_GH_REPO=amplifthq/opentag-test \
    scripts/dev/run-github-webhook-live-test.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3033}"
: "${OPENTAG_GITHUB_PORT:=3050}"
: "${OPENTAG_RUNNER_ID:=runner_github_webhook_live}"
: "${OPENTAG_CLAUDE_COMMAND:=claude}"
: "${OPENTAG_CLAUDE_PERMISSION_MODE:=acceptEdits}"
: "${OPENTAG_GH_REPO:=amplifthq/opentag-test}"
: "${OPENTAG_GH_LIVE_START_NGROK:=true}"
: "${OPENTAG_GH_LIVE_APPLY:=true}"
: "${OPENTAG_GH_LIVE_TIMEOUT_SECONDS:=900}"
: "${OPENTAG_GH_LIVE_COMMAND:=Add one short sentence to README.md saying GitHub can trigger local Claude Code through OpenTag. Keep the change small and do not modify anything else.}"
: "${OPENTAG_GH_LIVE_EXECUTOR:=claude-code}"
: "${OPENTAG_GH_LIVE_KEEP_WEBHOOK:=false}"
: "${OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN:=false}"

cd "$ROOT_DIR"

CLI_PID=""
NGROK_PID=""
TMP_ROOT=""
CONFIG_PATH=""
DATABASE_PATH=""
NGROK_LOG=""
HOOK_ID=""
ISSUE_NUMBER=""
PUBLIC_URL=""

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

  if [[ -n "$HOOK_ID" ]] && ! bool_true "$OPENTAG_GH_LIVE_KEEP_WEBHOOK"; then
    echo "Deleting temporary GitHub webhook $HOOK_ID..."
    gh api "repos/${OWNER}/${REPO}/hooks/${HOOK_ID}" --method DELETE >/dev/null 2>&1 || true
  fi

  kill_pid "$CLI_PID"
  kill_pid "$NGROK_PID"

  if [[ -n "$CONFIG_PATH" && -f "$CONFIG_PATH" ]]; then
    rm -f "$CONFIG_PATH"
  fi

  if [[ -n "$TMP_ROOT" ]]; then
    echo "Preserved temp root: $TMP_ROOT"
    echo "Removed temporary config file because it contains local credentials."
  fi
  if [[ -n "$DATABASE_PATH" ]]; then
    echo "Dispatcher DB: $DATABASE_PATH"
  fi
  if [[ -n "$ISSUE_NUMBER" ]]; then
    echo "Issue: https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}"
  fi

  exit "$status"
}
trap cleanup EXIT INT TERM

require_cmd curl
require_cmd gh
require_cmd lsof
require_cmd node
require_cmd python3
require_cmd sqlite3
if [[ "$OPENTAG_GH_LIVE_EXECUTOR" == "claude-code" ]]; then
  require_cmd "$OPENTAG_CLAUDE_COMMAND"
fi
if bool_true "$OPENTAG_GH_LIVE_START_NGROK"; then
  require_cmd ngrok
fi

OWNER="${OPENTAG_GH_REPO%%/*}"
REPO="${OPENTAG_GH_REPO#*/}"
if [[ -z "$OWNER" || -z "$REPO" || "$OWNER" == "$REPO" ]]; then
  echo "OPENTAG_GH_REPO must be owner/repo." >&2
  exit 1
fi
export OWNER REPO

PERMISSION="$(gh repo view "$OWNER/$REPO" --json viewerPermission --jq '.viewerPermission')"
if [[ "$PERMISSION" != "ADMIN" && "$PERMISSION" != "MAINTAIN" ]]; then
  echo "GitHub repository webhook creation requires ADMIN or MAINTAIN access; current permission is $PERMISSION." >&2
  exit 1
fi
GITHUB_TOKEN="$(gh auth token)"
export GITHUB_TOKEN
export OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN

if bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN" && bool_true "$OPENTAG_GH_LIVE_APPLY"; then
  echo "GitHub apply token is disabled for this run; skipping apply-comment execution and expecting Needs setup."
  OPENTAG_GH_LIVE_APPLY=false
fi

TMP_ROOT="$(mktemp -d /tmp/opentag-gh-webhook-live.XXXXXX)"
CONFIG_PATH="$TMP_ROOT/opentag-github-webhook-live.config.json"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$TMP_ROOT/opentag-github-webhook-live.db}"
CHECKOUT_PATH="${OPENTAG_WORKSPACE_PATH:-$TMP_ROOT/$REPO}"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
STATE_DIR="$TMP_ROOT/state"
NGROK_LOG="$TMP_ROOT/ngrok.log"
WEBHOOK_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
BASE_BRANCH="${OPENTAG_BASE_BRANCH:-main}"
PUSH_REMOTE="${OPENTAG_PUSH_REMOTE:-origin}"
export CHECKOUT_PATH WORKTREE_ROOT STATE_DIR CONFIG_PATH DATABASE_PATH WEBHOOK_SECRET BASE_BRANCH PUSH_REMOTE
export OPENTAG_PAIRING_TOKEN OPENTAG_DISPATCHER_PORT OPENTAG_GITHUB_PORT OPENTAG_RUNNER_ID
export OPENTAG_CLAUDE_COMMAND OPENTAG_CLAUDE_PERMISSION_MODE OPENTAG_GH_LIVE_EXECUTOR

ensure_port_free() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  if bool_true "${OPENTAG_GH_LIVE_KILL_PORTS:-false}"; then
    echo "Killing existing $label process(es) on :$port: $pids"
    for pid in $pids; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
    return 0
  fi
  echo "Port :$port is already in use by: $pids" >&2
  echo "Stop that process or rerun with OPENTAG_GH_LIVE_KILL_PORTS=true." >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url." >&2
  exit 1
}

wait_for_github_ingress() {
  local deadline=$((SECONDS + 60))
  local code
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${OPENTAG_GITHUB_PORT}/github/webhooks" -H "content-type: application/json" --data '{}' || true)"
    if [[ "$code" == "401" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for local GitHub ingress on :${OPENTAG_GITHUB_PORT}." >&2
  exit 1
}

ngrok_url_for_port() {
  local port="$1"
  python3 - "$port" <<'PY' 2>/dev/null || true
import json
import sys
import urllib.request

port = sys.argv[1]
with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
    payload = json.loads(resp.read())
for tunnel in payload.get("tunnels", []):
    public_url = tunnel.get("public_url", "")
    addr = str(tunnel.get("config", {}).get("addr", ""))
    if public_url.startswith("https://") and (addr.endswith(":" + port) or addr.endswith("//localhost:" + port) or addr.endswith("//127.0.0.1:" + port)):
        print(public_url.rstrip("/"))
        break
PY
}

wait_for_ngrok_url() {
  local port="$1"
  local deadline=$((SECONDS + 45))
  local url=""
  while (( SECONDS < deadline )); do
    url="$(ngrok_url_for_port "$port")"
    if [[ -n "$url" ]]; then
      printf "%s" "$url"
      return 0
    fi
    sleep 1
  done
  echo "ngrok did not expose an HTTPS tunnel for port $port." >&2
  if [[ -n "$NGROK_LOG" && -f "$NGROK_LOG" ]]; then
    tail -n 80 "$NGROK_LOG" >&2 || true
  fi
  exit 1
}

public_ingress_probe() {
  local public_url="$1"
  local code
  code="$(curl -sS -o "$TMP_ROOT/github-ingress-probe.json" -w "%{http_code}" -X POST "$public_url/github/webhooks" -H "content-type: application/json" --data '{}' || true)"
  if [[ "$code" == "401" ]]; then
    echo "Public GitHub ingress probe reached OpenTag (401 without GitHub signature is expected)."
    return 0
  fi
  echo "Public GitHub ingress probe returned HTTP $code, expected 401." >&2
  exit 1
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
    "applyPlanCount": metrics.get("applyPlanCount"),
    "childRunCount": metrics.get("childRunCount"),
    "threadNoiseRatio": metrics.get("threadNoiseRatio"),
    "applyOutcomeCounts": metrics.get("applyOutcomeCounts"),
}
print("Run metrics:", json.dumps(summary, sort_keys=True))
PY
}

issue_comments_contain() {
  local pattern="$1"
  gh issue view "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --json comments --jq '[
    .comments[].body
  ] | join("\n--- opentag-comment-boundary ---\n")' | grep -F "$pattern" >/dev/null
}

applied_receipt_has_double_period() {
  gh issue view "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --json comments --jq '
    .comments[].body
    | split("\n")[]
    | select(startswith("Applied:"))
  ' | grep -E '\.\.$' >/dev/null
}

latest_apply_plan_for_run() {
  local run_id_sql
  run_id_sql="$(sql_escape "$1")"
  sqlite_one "select ap.plan_json from apply_plans ap join suggested_changes sc on sc.proposal_id = ap.proposal_id where sc.run_id = '$run_id_sql' order by ap.created_at desc limit 1;"
}

if [[ ! -d "$CHECKOUT_PATH/.git" ]]; then
  echo "Cloning $OWNER/$REPO into temporary checkout..."
  gh repo clone "$OWNER/$REPO" "$CHECKOUT_PATH" >/dev/null
fi
if [[ -n "$(git -C "$CHECKOUT_PATH" status --porcelain)" ]]; then
  echo "Checkout is dirty: $CHECKOUT_PATH" >&2
  exit 1
fi

python3 - <<'PY'
import json
import os
from pathlib import Path

config = {
    "schemaVersion": 1,
    "state": {
        "directory": os.environ["STATE_DIR"],
        "databasePath": os.environ["DATABASE_PATH"],
        "worktreeRoot": os.environ["WORKTREE_ROOT"],
    },
    "preferences": {
        "language": "en",
        "lastSetup": {
            "platforms": ["github"],
            "executor": os.environ["OPENTAG_GH_LIVE_EXECUTOR"],
            "projectPath": os.environ["CHECKOUT_PATH"],
            "githubOwner": os.environ["OWNER"],
            "githubRepo": os.environ["REPO"],
            "githubPort": int(os.environ["OPENTAG_GITHUB_PORT"]),
        },
    },
    "daemon": {
        "runnerId": os.environ["OPENTAG_RUNNER_ID"],
        "dispatcherUrl": f"http://localhost:{os.environ['OPENTAG_DISPATCHER_PORT']}",
        "repositories": [
            {
                "provider": "github",
                "owner": os.environ["OWNER"],
                "repo": os.environ["REPO"],
                "checkoutPath": os.environ["CHECKOUT_PATH"],
                "defaultExecutor": os.environ["OPENTAG_GH_LIVE_EXECUTOR"],
                "baseBranch": os.environ["BASE_BRANCH"],
                "pushRemote": os.environ["PUSH_REMOTE"],
                "worktreeRoot": os.environ["WORKTREE_ROOT"],
                "keepWorktree": "on_failure",
            }
        ],
        "claudeCode": {
            "command": os.environ["OPENTAG_CLAUDE_COMMAND"],
            "permissionMode": os.environ["OPENTAG_CLAUDE_PERMISSION_MODE"],
        },
        "githubToken": os.environ["GITHUB_TOKEN"],
        **(
            {"githubApplyToken": None}
            if os.environ.get("OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN", "").lower() in {"1", "true", "yes", "y"}
            else {}
        ),
        "preparePullRequestBranch": True,
        "pairingToken": os.environ["OPENTAG_PAIRING_TOKEN"],
        "pollIntervalMs": 1000,
        "heartbeatIntervalMs": 15000,
    },
    "platforms": {
        "github": {
            "webhookSecret": os.environ["WEBHOOK_SECRET"],
            "owner": os.environ["OWNER"],
            "repo": os.environ["REPO"],
            "webhookPath": "/github/webhooks",
            "port": int(os.environ["OPENTAG_GITHUB_PORT"]),
        }
    },
}

path = Path(os.environ["CONFIG_PATH"])
path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

ensure_port_free "$OPENTAG_DISPATCHER_PORT" "dispatcher"
ensure_port_free "$OPENTAG_GITHUB_PORT" "GitHub ingress"

echo "Starting OpenTag CLI stack on dispatcher :${OPENTAG_DISPATCHER_PORT}, GitHub ingress :${OPENTAG_GITHUB_PORT}"
NODE_OPTIONS='--conditions=development' packages/cli/node_modules/.bin/tsx packages/cli/src/index.ts start --config "$CONFIG_PATH" &
CLI_PID=$!

wait_for_http "http://localhost:${OPENTAG_DISPATCHER_PORT}/healthz"
wait_for_github_ingress

PUBLIC_URL="${OPENTAG_GH_PUBLIC_URL:-}"
if bool_true "$OPENTAG_GH_LIVE_START_NGROK"; then
  existing_tunnel="$(ngrok_url_for_port "$OPENTAG_GITHUB_PORT")"
  if [[ -n "$existing_tunnel" && -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="$existing_tunnel"
    echo "Using existing ngrok tunnel for GitHub ingress: $PUBLIC_URL"
  elif [[ -z "$existing_tunnel" ]]; then
    if [[ -n "$(lsof -ti tcp:4040 2>/dev/null || true)" ]]; then
      echo "ngrok API port :4040 is in use, but no tunnel points at :${OPENTAG_GITHUB_PORT}." >&2
      echo "Stop that ngrok process, or set OPENTAG_GH_PUBLIC_URL to a tunnel that points at this GitHub ingress." >&2
      exit 1
    fi
    echo "Starting ngrok for GitHub ingress"
    if [[ -n "$PUBLIC_URL" ]]; then
      ngrok http "$OPENTAG_GITHUB_PORT" --url "${PUBLIC_URL#https://}" --log stdout >"$NGROK_LOG" 2>&1 &
    else
      ngrok http "$OPENTAG_GITHUB_PORT" --log stdout >"$NGROK_LOG" 2>&1 &
    fi
    NGROK_PID=$!
    STARTED_URL="$(wait_for_ngrok_url "$OPENTAG_GITHUB_PORT")"
    if [[ -z "$PUBLIC_URL" ]]; then
      PUBLIC_URL="$STARTED_URL"
    fi
  fi
fi
if [[ -z "$PUBLIC_URL" ]]; then
  echo "Set OPENTAG_GH_PUBLIC_URL or enable OPENTAG_GH_LIVE_START_NGROK=true." >&2
  exit 1
fi
PUBLIC_URL="${PUBLIC_URL%/}"
public_ingress_probe "$PUBLIC_URL"

echo "Creating temporary GitHub repository webhook for ${OWNER}/${REPO}"
HOOK_ID="$(
  python3 - <<PY | gh api "repos/${OWNER}/${REPO}/hooks" --method POST --input - --jq '.id'
import json
print(json.dumps({
    "name": "web",
    "active": True,
    "events": ["issue_comment", "pull_request_review_comment"],
    "config": {
        "url": "${PUBLIC_URL}/github/webhooks",
        "content_type": "json",
        "secret": "${WEBHOOK_SECRET}",
        "insecure_ssl": "0",
    },
}))
PY
)"
echo "Temporary webhook id: $HOOK_ID"

ISSUE_URL="$(gh issue create --repo "${OWNER}/${REPO}" \
  --title "OpenTag GitHub webhook live test" \
  --body "Temporary issue for validating OpenTag repository webhook -> local agent -> GitHub source-thread action receipts.")"
ISSUE_NUMBER="${ISSUE_URL##*/}"
echo "Created issue: $ISSUE_URL"

WAIT_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
MENTION_BODY="@opentag run ${OPENTAG_GH_LIVE_COMMAND}"
echo "Posting mention comment through GitHub..."
MENTION_URL="$(gh issue comment "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --body "$MENTION_BODY")"
echo "Mention comment: $MENTION_URL"

RUN_ID=""
ISSUE_SQL="$(sql_escape "$ISSUE_NUMBER")"
STARTED_SQL="$(sql_escape "$WAIT_STARTED_AT")"
deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  RUN_ID="$(
    sqlite_one "select id from runs where json_extract(event_json, '$.source') = 'github' and json_extract(event_json, '$.metadata.issueNumber') = $ISSUE_SQL and created_at >= '$STARTED_SQL' order by created_at desc limit 1;"
  )"
  if [[ -n "$RUN_ID" ]]; then
    break
  fi
  sleep 2
done
if [[ -z "$RUN_ID" ]]; then
  echo "Timed out waiting for GitHub webhook-created run." >&2
  exit 1
fi
echo "Detected GitHub webhook-created run: $RUN_ID"

last_status=""
deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
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

echo "Recent issue comments after final receipt:"
gh issue view "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --json comments --jq '.comments[-4:][] | {author: .author.login, body: (.body | split("\n")[0:8] | join("\n"))}'
EXPECTED_HEADING="### Ready to apply"
if bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN"; then
  EXPECTED_HEADING="### Needs setup"
fi
if bool_true "$OPENTAG_GH_LIVE_DISABLE_APPLY_TOKEN"; then
  if ! issue_comments_contain "$EXPECTED_HEADING"; then
    echo "Expected the final GitHub receipt to render '$EXPECTED_HEADING'." >&2
    exit 1
  fi
  if issue_comments_contain '`apply 1`'; then
    echo "Expected the missing-apply-token receipt not to advertise the apply command." >&2
    exit 1
  fi
elif ! issue_comments_contain "### Ready to apply" &&
  ! issue_comments_contain "### Some actions need setup" &&
  ! issue_comments_contain "### Some actions need attention" &&
  ! issue_comments_contain "### Needs review"; then
  echo "Expected the final GitHub receipt to render a ready or mixed-state action heading." >&2
  exit 1
elif ! issue_comments_contain '`apply 1`'; then
  echo "Expected the final GitHub receipt to advertise apply 1 for the ready action." >&2
  exit 1
fi

if bool_true "$OPENTAG_GH_LIVE_APPLY"; then
  before_count="$(sqlite_one "select count(*) from approval_decisions;")"
  echo "Replying apply 1 through GitHub..."
  APPLY_URL="$(gh issue comment "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --body "apply 1")"
  echo "Apply comment: $APPLY_URL"

  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    after_count="$(sqlite_one "select count(*) from approval_decisions;")"
    if [[ -n "$after_count" && -n "$before_count" && "$after_count" -gt "$before_count" ]]; then
      break
    fi
    sleep 2
  done
  if [[ "${after_count:-0}" -le "${before_count:-0}" ]]; then
    echo "Timed out waiting for approval decision from GitHub apply comment." >&2
    exit 1
  fi

  PR_URL=""
  deadline=$((SECONDS + OPENTAG_GH_LIVE_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    plan_json="$(latest_apply_plan_for_run "$RUN_ID")"
    if [[ -n "$plan_json" ]]; then
      PR_URL="$(python3 - "$plan_json" <<'PY' || true
import json
import sys
plan = json.loads(sys.argv[1])
for outcome in plan.get("outcomes", []):
    if outcome.get("externalUri"):
        print(outcome["externalUri"])
        break
PY
)"
      executed="$(python3 - "$plan_json" <<'PY' || true
import json
import sys
plan = json.loads(sys.argv[1])
print("true" if plan.get("adapterPlan", {}).get("externalWritesExecuted") else "false")
PY
)"
      if [[ -n "$PR_URL" && "$executed" == "true" ]]; then
        break
      fi
    fi
    sleep 2
  done
  if [[ -z "$PR_URL" ]]; then
    echo "Timed out waiting for applied PR URL." >&2
    latest_apply_plan_for_run "$RUN_ID" | python3 -m json.tool || true
    exit 1
  fi
  echo "Created PR: $PR_URL"
  gh pr view "$PR_URL" --json number,state,headRefName,baseRefName,url --jq '{number,state,headRefName,baseRefName,url}'
  print_metrics "$RUN_ID"
  echo "Recent issue comments after apply receipt:"
  gh issue view "$ISSUE_NUMBER" --repo "${OWNER}/${REPO}" --json comments --jq '.comments[-5:][] | {author: .author.login, body: (.body | split("\n")[0:8] | join("\n"))}'
  if ! issue_comments_contain "Applied:"; then
    echo "Expected the GitHub thread to contain an applied receipt." >&2
    exit 1
  fi
  if applied_receipt_has_double_period; then
    echo "Applied receipt ended with duplicate punctuation." >&2
    exit 1
  fi
fi

echo
echo "GitHub repository-webhook live test completed."
echo "- Issue: https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}"
echo "- Run ID: $RUN_ID"
if [[ -n "${PR_URL:-}" ]]; then
  echo "- Pull request: $PR_URL"
fi
