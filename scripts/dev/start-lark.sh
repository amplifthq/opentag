#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.opentag/lark"
CONFIG_PATH="$STATE_DIR/opentag.local.json"

DISPATCHER_PID=""
DAEMON_PID=""
LARK_PID=""

cleanup() {
  for pid in "$LARK_PID" "$DAEMON_PID" "$DISPATCHER_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required."
  fi
}

workspace_dependencies_installed() {
  [[ -x "$ROOT_DIR/apps/dispatcher/node_modules/.bin/tsx" ]] &&
    [[ -x "$ROOT_DIR/apps/opentagd/node_modules/.bin/tsx" ]] &&
    [[ -x "$ROOT_DIR/apps/lark-events/node_modules/.bin/tsx" ]] &&
    [[ -d "$ROOT_DIR/apps/lark-events/node_modules/qrcode-terminal" ]]
}

read_with_default() {
  local prompt="$1"
  local default_value="$2"
  local value
  if [[ -n "$default_value" ]]; then
    read -r -p "$prompt [$default_value]: " value
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$prompt: " value
    printf '%s' "$value"
  fi
}

read_secret_with_default() {
  local prompt="$1"
  local default_value="$2"
  local value
  if [[ -n "$default_value" ]]; then
    read -r -s -p "$prompt [already set]: " value
    printf '\n' >&2
    printf '%s' "${value:-$default_value}"
  else
    read -r -s -p "$prompt: " value
    printf '\n' >&2
    printf '%s' "$value"
  fi
}

absolute_path() {
  local raw="$1"
  if [[ "$raw" == "~" ]]; then
    raw="$HOME"
  elif [[ "$raw" == ~/* ]]; then
    raw="$HOME/${raw#~/}"
  fi
  node -e 'const path = require("node:path"); console.log(path.resolve(process.argv[1]));' "$raw"
}

infer_github_slug() {
  local checkout_path="$1"
  local remote_url
  remote_url="$(git -C "$checkout_path" remote get-url origin 2>/dev/null || true)"
  remote_url="${remote_url%.git}"
  case "$remote_url" in
    https://github.com/*)
      printf '%s' "${remote_url#https://github.com/}"
      ;;
    git@github.com:*)
      printf '%s' "${remote_url#git@github.com:}"
      ;;
    ssh://git@github.com/*)
      printf '%s' "${remote_url#ssh://git@github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
}

port_is_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${port}" >/dev/null 2>&1
    return
  fi
  nc -z 127.0.0.1 "$port" >/dev/null 2>&1
}

choose_dispatcher_port() {
  local requested="${OPENTAG_DISPATCHER_PORT:-}"
  local port="${requested:-3030}"
  if [[ -n "$requested" ]]; then
    if port_is_in_use "$port"; then
      fail "Port $port is already in use. Set OPENTAG_DISPATCHER_PORT to a free port."
    fi
    printf '%s' "$port"
    return
  fi

  while port_is_in_use "$port"; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

wait_for_dispatcher() {
  local url="$1"
  for _ in $(seq 1 60); do
    if node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));' "$url/healthz"; then
      return
    fi
    sleep 0.5
  done
  fail "Dispatcher did not become healthy at $url."
}

detect_executor() {
  if [[ -n "${OPENTAG_LARK_EXECUTOR:-}" ]]; then
    printf '%s' "$OPENTAG_LARK_EXECUTOR"
  elif command -v codex >/dev/null 2>&1; then
    printf 'codex'
  elif command -v claude >/dev/null 2>&1; then
    printf 'claude-code'
  else
    printf 'echo'
  fi
}

validate_executor() {
  case "$1" in
    echo|codex|claude-code)
      return
      ;;
    *)
      fail "Executor must be echo, codex, or claude-code."
      ;;
  esac
}

assert_executor_available() {
  case "$1" in
    codex)
      require_command codex
      ;;
    claude-code)
      require_command claude
      ;;
    echo)
      ;;
  esac
}

json_field() {
  local field="$1"
  FIELD="$field" node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const value = data[process.env.FIELD];
if (typeof value === "string") process.stdout.write(value);
' <<< "$REGISTRATION_JSON"
}

register_lark_personal_agent() {
  (
    cd "$ROOT_DIR/apps/lark-events"
    node scripts/register-personal-agent.cjs "$LARK_DOMAIN"
  )
}

write_config() {
  mkdir -p "$STATE_DIR" "$STATE_DIR/worktrees"
  CONFIG_PATH="$CONFIG_PATH" \
  RUNNER_ID="$RUNNER_ID" \
  DISPATCHER_URL="$DISPATCHER_URL" \
  PAIRING_TOKEN="$PAIRING_TOKEN" \
  REPO_PROVIDER="$REPO_PROVIDER" \
  REPO_OWNER="$REPO_OWNER" \
  REPO_NAME="$REPO_NAME" \
  CHECKOUT_PATH="$CHECKOUT_PATH" \
  EXECUTOR="$EXECUTOR" \
  BASE_BRANCH="$BASE_BRANCH" \
  PUSH_REMOTE="$PUSH_REMOTE" \
  WORKTREE_ROOT="$STATE_DIR/worktrees" \
  node <<'NODE'
const { writeFileSync, chmodSync } = require("node:fs");

const config = {
  runnerId: process.env.RUNNER_ID,
  dispatcherUrl: process.env.DISPATCHER_URL,
  pairingToken: process.env.PAIRING_TOKEN,
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 15000,
  repositories: [
    {
      provider: process.env.REPO_PROVIDER,
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      checkoutPath: process.env.CHECKOUT_PATH,
      defaultExecutor: process.env.EXECUTOR,
      baseBranch: process.env.BASE_BRANCH,
      pushRemote: process.env.PUSH_REMOTE,
      worktreeRoot: process.env.WORKTREE_ROOT,
      keepWorktree: "on_failure"
    }
  ]
};

if (process.env.EXECUTOR === "claude-code") {
  config.claudeCode = {
    command: process.env.OPENTAG_CLAUDE_COMMAND || "claude",
    permissionMode: process.env.OPENTAG_CLAUDE_PERMISSION_MODE || "acceptEdits"
  };
}

writeFileSync(process.env.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
chmodSync(process.env.CONFIG_PATH, 0o600);
NODE
}

run_opentagd() {
  local command_name="$1"
  shift || true
  (
    cd "$ROOT_DIR"
    OPENTAG_CONFIG_PATH="$CONFIG_PATH" \
    NODE_OPTIONS='--conditions=development' \
    corepack pnpm --filter @opentag/opentagd dev -- "$command_name" "$@"
  )
}

require_command node
require_command git
require_command corepack

log "OpenTag for Lark"
log
log "This starts a local OpenTag stack that lets Lark wake an agent on this computer."
log

if ! workspace_dependencies_installed; then
  log "Installing workspace dependencies with corepack pnpm install..."
  (cd "$ROOT_DIR" && corepack pnpm install)
fi

DEFAULT_CHECKOUT="$(git -C "$ROOT_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$ROOT_DIR")"
CHECKOUT_INPUT="${OPENTAG_WORKSPACE_PATH:-$(read_with_default "Local project path for this agent" "$DEFAULT_CHECKOUT")}"
CHECKOUT_PATH="$(absolute_path "$CHECKOUT_INPUT")"

[[ -d "$CHECKOUT_PATH" ]] || fail "Project path does not exist: $CHECKOUT_PATH"
git -C "$CHECKOUT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Project path must be a git checkout: $CHECKOUT_PATH"

INFERRED_SLUG="$(infer_github_slug "$CHECKOUT_PATH" || true)"
if [[ -n "${OPENTAG_REPO_OWNER:-}" && -n "${OPENTAG_REPO_NAME:-}" ]]; then
  REPO_OWNER="$OPENTAG_REPO_OWNER"
  REPO_NAME="$OPENTAG_REPO_NAME"
elif [[ -n "$INFERRED_SLUG" && "$INFERRED_SLUG" == */* ]]; then
  REPO_SLUG="$INFERRED_SLUG"
  log "Using repo from git origin: $REPO_SLUG"
  REPO_OWNER="${REPO_SLUG%%/*}"
  REPO_NAME="${REPO_SLUG#*/}"
else
  REPO_SLUG="$(read_with_default "GitHub repo for this checkout (owner/repo)" "")"
  [[ "$REPO_SLUG" == */* ]] || fail "Repo must be formatted as owner/repo."
  REPO_OWNER="${REPO_SLUG%%/*}"
  REPO_NAME="${REPO_SLUG#*/}"
fi

REPO_PROVIDER="${OPENTAG_REPO_PROVIDER:-github}"
BASE_BRANCH="${OPENTAG_BASE_BRANCH:-$(git -C "$CHECKOUT_PATH" branch --show-current 2>/dev/null || true)}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PUSH_REMOTE="${OPENTAG_PUSH_REMOTE:-origin}"

DETECTED_EXECUTOR="$(detect_executor)"
EXECUTOR="$(read_with_default "Executor for local runs (codex, claude-code, echo; choose codex for a real local agent)" "$DETECTED_EXECUTOR")"
validate_executor "$EXECUTOR"
assert_executor_available "$EXECUTOR"

LARK_DOMAIN="$(read_with_default "Lark domain (lark or feishu)" "${LARK_DOMAIN:-lark}")"
case "$LARK_DOMAIN" in
  lark|feishu)
    ;;
  *)
    fail "Lark domain must be lark or feishu."
    ;;
esac

if [[ -n "${LARK_APP_ID:-}" && -n "${LARK_APP_SECRET:-}" ]]; then
  log "Using LARK_APP_ID and LARK_APP_SECRET from the environment."
else
  LARK_SETUP_MODE="$(read_with_default "Lark app setup (scan or manual)" "${OPENTAG_LARK_APP_SETUP:-scan}")"
  case "$LARK_SETUP_MODE" in
    scan)
      REGISTRATION_JSON="$(register_lark_personal_agent)"
      LARK_APP_ID="$(json_field appId)"
      LARK_APP_SECRET="$(json_field appSecret)"
      DETECTED_LARK_DOMAIN="$(json_field domain)"
      DETECTED_LARK_BOT_OPEN_ID="$(json_field botOpenId)"
      if [[ -n "$DETECTED_LARK_DOMAIN" ]]; then
        LARK_DOMAIN="$DETECTED_LARK_DOMAIN"
      fi
      if [[ -n "$DETECTED_LARK_BOT_OPEN_ID" && -z "${LARK_BOT_OPEN_ID:-}" ]]; then
        LARK_BOT_OPEN_ID="$DETECTED_LARK_BOT_OPEN_ID"
      fi
      ;;
    manual)
      LARK_APP_ID="$(read_with_default "LARK_APP_ID" "${LARK_APP_ID:-}")"
      LARK_APP_SECRET="$(read_secret_with_default "LARK_APP_SECRET" "${LARK_APP_SECRET:-}")"
      ;;
    *)
      fail "Lark app setup must be scan or manual."
      ;;
  esac
fi

[[ -n "$LARK_APP_ID" ]] || fail "LARK_APP_ID is required."
[[ -n "$LARK_APP_SECRET" ]] || fail "LARK_APP_SECRET is required."

LARK_BOT_OPEN_ID="${LARK_BOT_OPEN_ID:-}"
if [[ -n "$LARK_BOT_OPEN_ID" ]]; then
  log "Using LARK_BOT_OPEN_ID for group @mentions."
else
  USE_GROUP="$(read_with_default "Will you test in a Lark group chat? (y/N)" "${OPENTAG_LARK_GROUP_CHAT:-N}")"
  case "$USE_GROUP" in
    y|Y|yes|YES)
      LARK_BOT_OPEN_ID="$(read_with_default "LARK_BOT_OPEN_ID for group @mentions" "$LARK_BOT_OPEN_ID")"
      [[ -n "$LARK_BOT_OPEN_ID" ]] || fail "LARK_BOT_OPEN_ID is required for group chat triggers."
      ;;
    *)
      log "Direct Lark messages can run without LARK_BOT_OPEN_ID. Group messages require it."
      ;;
  esac
fi

PAIRING_TOKEN="${OPENTAG_PAIRING_TOKEN:-dev_pairing_token}"
RUNNER_ID="${OPENTAG_RUNNER_ID:-runner_lark_local}"
DISPATCHER_PORT="$(choose_dispatcher_port)"
DISPATCHER_URL="http://localhost:$DISPATCHER_PORT"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$STATE_DIR/opentag.db}"
DEFAULT_REPO="$REPO_PROVIDER:$REPO_OWNER/$REPO_NAME"

write_config

log
log "Starting OpenTag for Lark"
log "- Project: $REPO_OWNER/$REPO_NAME"
log "- Path: $CHECKOUT_PATH"
log "- Executor: $EXECUTOR"
log "- Dispatcher: $DISPATCHER_URL"
log "- Config: $CONFIG_PATH"
log

(
  cd "$ROOT_DIR"
  export PORT="$DISPATCHER_PORT"
  export OPENTAG_DATABASE_PATH="$DATABASE_PATH"
  export OPENTAG_PAIRING_TOKEN="$PAIRING_TOKEN"
  export LARK_APP_ID
  export LARK_APP_SECRET
  export LARK_DOMAIN
  NODE_OPTIONS='--conditions=development' corepack pnpm --filter @opentag/dispatcher-app dev
) &
DISPATCHER_PID=$!

wait_for_dispatcher "$DISPATCHER_URL"

log "Registering local runner and binding the selected project..."
run_opentagd register-runner
run_opentagd bind-repos

log "Starting local daemon..."
(
  cd "$ROOT_DIR"
  OPENTAG_CONFIG_PATH="$CONFIG_PATH" \
  NODE_OPTIONS='--conditions=development' \
  corepack pnpm --filter @opentag/opentagd dev -- serve
) &
DAEMON_PID=$!

log "Starting Lark long-connection ingress..."
(
  cd "$ROOT_DIR"
  export LARK_APP_ID
  export LARK_APP_SECRET
  export LARK_DOMAIN
  export OPENTAG_DISPATCHER_URL="$DISPATCHER_URL"
  export OPENTAG_DISPATCHER_TOKEN="$PAIRING_TOKEN"
  export OPENTAG_LARK_DEFAULT_REPO="$DEFAULT_REPO"
  export OPENTAG_LARK_AGENT_ID="${OPENTAG_LARK_AGENT_ID:-opentag}"
  if [[ -n "$LARK_BOT_OPEN_ID" ]]; then
    export LARK_BOT_OPEN_ID
  fi
  NODE_OPTIONS='--conditions=development' corepack pnpm --filter @opentag/lark-events dev
) &
LARK_PID=$!

log
log "OpenTag for Lark is running."
log
log "Try this in a direct chat with the bot:"
log "  say hello from my local computer"
log
if [[ -n "$LARK_BOT_OPEN_ID" ]]; then
  log "Try this in a group chat:"
  log "  @OpenTag say hello from my local computer"
  log
else
  log "Group chat needs LARK_BOT_OPEN_ID. Direct chat is ready now."
  log
fi
log "This script auto-connects the first Lark chat that messages the bot to $DEFAULT_REPO."
log "To point a chat at another repo later, send:"
log "  @OpenTag /bind owner/repo"
log
log "Expected AHA moment:"
log "1. Lark replies with an acknowledgement."
log "2. This terminal shows the local daemon running the executor."
log "3. Lark replies with the final result."
log
log "Press Ctrl-C to stop OpenTag."
wait
