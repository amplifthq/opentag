#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${OPENTAG_PAIRING_TOKEN:=dev_pairing_token}"
: "${OPENTAG_DISPATCHER_PORT:=3032}"
: "${OPENTAG_RUNNER_ID:=runner_claude_local}"
: "${OPENTAG_CLAUDE_PERMISSION_MODE:=acceptEdits}"

DISPATCHER_PORT="${OPENTAG_DISPATCHER_PORT}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install and authenticate GitHub CLI first." >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found. Install/login to Claude Code first." >&2
  exit 1
fi

cd "$ROOT_DIR"

TARGET_REPO="${OPENTAG_GH_REPO:-}"
if [[ -z "$TARGET_REPO" ]]; then
  OWNER="$(gh repo view --json owner --jq '.owner.login')"
  REPO="$(gh repo view --json name --jq '.name')"
  REPO_URL="$(gh repo view --json url --jq '.url')"
else
  OWNER="${TARGET_REPO%%/*}"
  REPO="${TARGET_REPO#*/}"
  REPO_URL="$(gh repo view "$TARGET_REPO" --json url --jq '.url')"
fi
GITHUB_TOKEN="$(gh auth token)"
CHECKOUT_PATH="${OPENTAG_WORKSPACE_PATH:-$ROOT_DIR}"
ISSUE_NUMBER="${OPENTAG_GH_TEST_ISSUE:-}"
PR_CREATE_PERMISSION=""
if [[ "${OPENTAG_GH_CREATE_PR:-false}" == "true" ]]; then
  PR_CREATE_PERMISSION=', { scope: "pr:create", reason: "open a pull request for completed code changes" }'
fi

if [[ ! -d "$CHECKOUT_PATH/.git" ]]; then
  mkdir -p "$(dirname "$CHECKOUT_PATH")"
  gh repo clone "${OWNER}/${REPO}" "$CHECKOUT_PATH" >/dev/null
fi

if [[ -z "$ISSUE_NUMBER" ]]; then
  if [[ "${OPENTAG_GH_CREATE_ISSUE:-false}" != "true" ]]; then
    echo "No OPENTAG_GH_TEST_ISSUE set and OPENTAG_GH_CREATE_ISSUE is not true." >&2
    echo "Set OPENTAG_GH_TEST_ISSUE=<issue-number>, or rerun with OPENTAG_GH_CREATE_ISSUE=true to create a temporary issue." >&2
    exit 1
  fi
  ISSUE_URL="$(gh issue create --repo "${OWNER}/${REPO}" \
    --title "OpenTag Claude Code local smoke test" \
    --body "Temporary issue for validating OpenTag -> local Claude Code -> GitHub callback.")"
  ISSUE_NUMBER="${ISSUE_URL##*/}"
fi

ISSUE_URL="${REPO_URL}/issues/${ISSUE_NUMBER}"
COMMENTS_API_URL="https://api.github.com/repos/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}/comments"
RUN_ID="run_gh_claude_$(date +%s)"
EVENT_ID="evt_gh_claude_${RUN_ID}"
ACTOR_ID="$(gh api user --jq '.id')"
ACTOR_LOGIN="$(gh api user --jq '.login')"
RUN_COMMAND="${OPENTAG_GH_TEST_COMMAND:-Investigate this issue and make the smallest useful local progress. If you change files, keep the change narrow and run relevant verification.}"
CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/opentag-gh-claude-config.XXXXXX.json")"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-opentag.gh-claude-local-test.db}"

cat > "$CONFIG_PATH" <<JSON
{
  "runnerId": "${OPENTAG_RUNNER_ID}",
  "dispatcherUrl": "http://localhost:${DISPATCHER_PORT}",
  "pairingToken": "${OPENTAG_PAIRING_TOKEN}",
  "githubToken": "${GITHUB_TOKEN}",
  "allowAutoCreatePullRequest": ${OPENTAG_GH_CREATE_PR:-false},
  "pollIntervalMs": 1000,
  "heartbeatIntervalMs": 15000,
  "claudeCode": {
    "command": "${OPENTAG_CLAUDE_COMMAND:-claude}",
    "permissionMode": "${OPENTAG_CLAUDE_PERMISSION_MODE}"
  },
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
  ]
}
JSON

cleanup() {
  rm -f "$CONFIG_PATH"
  if [[ -n "${DISPATCHER_PID:-}" ]]; then
    kill "$DISPATCHER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! port_is_in_use "$DISPATCHER_PORT"; then
        break
      fi
      sleep 0.25
    done
    if port_is_in_use "$DISPATCHER_PORT"; then
      kill -9 "$DISPATCHER_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do
        if ! port_is_in_use "$DISPATCHER_PORT"; then
          break
        fi
        sleep 0.25
      done
    fi
  fi
}
trap cleanup EXIT

port_is_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" >/dev/null 2>&1
    return
  fi
  nc -z localhost "$port" >/dev/null 2>&1
}

dispatcher_pids_for_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" 2>/dev/null || true
    return
  fi
  pgrep -f "apps/dispatcher/src/index.ts" 2>/dev/null || true
}

echo "Starting dispatcher on :${DISPATCHER_PORT}"
for pid in $(dispatcher_pids_for_port "${DISPATCHER_PORT}"); do
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 20); do
  if ! port_is_in_use "${DISPATCHER_PORT}"; then
    break
  fi
  sleep 0.25
done
if port_is_in_use "${DISPATCHER_PORT}"; then
  for pid in $(dispatcher_pids_for_port "${DISPATCHER_PORT}"); do
    kill -9 "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    if ! port_is_in_use "${DISPATCHER_PORT}"; then
      break
    fi
    sleep 0.25
  done
fi
if port_is_in_use "${DISPATCHER_PORT}"; then
  echo "Dispatcher port ${DISPATCHER_PORT} is still in use; free it or install lsof for more reliable cleanup." >&2
  exit 1
fi
(
  export PORT="$DISPATCHER_PORT"
  export OPENTAG_DATABASE_PATH="$DATABASE_PATH"
  export OPENTAG_PAIRING_TOKEN
  export OPENTAG_GITHUB_TOKEN="$GITHUB_TOKEN"
  NODE_OPTIONS='--conditions=development' apps/dispatcher/node_modules/.bin/tsx apps/dispatcher/src/index.ts
) &
DISPATCHER_PID=$!

sleep 2

echo "Registering runner and binding ${OWNER}/${REPO}"
OPENTAG_CONFIG_PATH="$CONFIG_PATH" NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts register-runner
OPENTAG_CONFIG_PATH="$CONFIG_PATH" NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts bind-repos

echo "Creating dispatcher run ${RUN_ID} for ${ISSUE_URL}"
OPENTAG_RUN_COMMAND="$RUN_COMMAND" node <<NODE
const body = {
  runId: "${RUN_ID}",
  event: {
    id: "${EVENT_ID}",
    source: "github",
    sourceEventId: "gh_cli_${ISSUE_NUMBER}_${RUN_ID}",
    receivedAt: new Date().toISOString(),
    actor: {
      provider: "github",
      providerUserId: "${ACTOR_ID}",
      handle: "${ACTOR_LOGIN}"
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      executorHint: "claude-code"
    },
    command: {
      rawText: process.env.OPENTAG_RUN_COMMAND,
      intent: "investigate",
      args: {}
    },
    context: [
      { provider: "github", kind: "repo", uri: "${REPO_URL}", visibility: "public" },
      { provider: "github", kind: "issue", uri: "${ISSUE_URL}", visibility: "public" }
    ],
    workItem: {
      provider: "github",
      kind: "issue",
      externalId: "${OWNER}/${REPO}#${ISSUE_NUMBER}",
      uri: "${ISSUE_URL}",
      ownerContainer: {
        provider: "github",
        id: "${OWNER}/${REPO}",
        uri: "${REPO_URL}"
      }
    },
    permissions: [
      { scope: "issue:comment", reason: "reply to the source GitHub thread" },
      { scope: "runner:local", reason: "execute the run on a paired local daemon" },
      { scope: "repo:read", reason: "inspect the local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" }${PR_CREATE_PERMISSION}
    ],
    callback: {
      provider: "github",
      uri: "${COMMENTS_API_URL}",
      threadKey: "${OWNER}/${REPO}#${ISSUE_NUMBER}"
    },
    metadata: {
      owner: "${OWNER}",
      repo: "${REPO}",
      issueNumber: Number("${ISSUE_NUMBER}")
    }
  }
};

fetch("http://localhost:${DISPATCHER_PORT}/v1/runs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": "Bearer ${OPENTAG_PAIRING_TOKEN}"
  },
  body: JSON.stringify(body)
}).then(async (response) => {
  if (!response.ok) {
    throw new Error(\`create run failed: \${response.status} \${await response.text()}\`);
  }
  console.log(await response.text());
});
NODE

echo "Running local daemon once with Claude Code"
OPENTAG_CONFIG_PATH="$CONFIG_PATH" NODE_OPTIONS='--conditions=development' apps/opentagd/node_modules/.bin/tsx apps/opentagd/src/index.ts run-once

echo
echo "GitHub-assisted Claude Code local test completed."
echo "- Issue: ${ISSUE_URL}"
echo "- Run ID: ${RUN_ID}"
echo "- Workspace: ${CHECKOUT_PATH}"
echo "- Dispatcher DB: ${DATABASE_PATH}"
