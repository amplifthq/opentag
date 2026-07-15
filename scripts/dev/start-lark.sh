#!/usr/bin/env bash
set -euo pipefail

# Dev smoke helper only. Do not extend this into the product setup path; the
# OpenTag CLI will replace this script after the runtime boundaries are ready.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.opentag/lark"
CONFIG_PATH="$STATE_DIR/opentag.local.json"
LARK_CONFIG_PATH="$STATE_DIR/lark.local.json"

DISPATCHER_PID=""
DAEMON_PID=""
LARK_PID=""
CLEANING_UP=""

cleanup() {
  if [[ -n "$CLEANING_UP" ]]; then
    return
  fi
  CLEANING_UP=1
  for pid in "$LARK_PID" "$DAEMON_PID" "$DISPATCHER_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$LARK_PID" "$DAEMON_PID" "$DISPATCHER_PID"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

canonical_path() {
  node -e 'const fs = require("node:fs"); console.log(fs.realpathSync.native(process.argv[1]));' "$1"
}

local_project_ref() {
  local checkout_path="$1"
  (
    cd "$ROOT_DIR/apps/lark-events"
    NODE_OPTIONS='--conditions=development' node_modules/.bin/tsx \
      ../../scripts/dev/print-local-project-target-ref.ts "$checkout_path"
  )
}

port_is_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
      return 0
    fi
    return 1
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
    if node -e '
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000).unref();
fetch(process.argv[1], { signal: ctrl.signal })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
' "$url/healthz"; then
      return
    fi
    sleep 0.5
  done
  fail "Dispatcher did not become healthy at $url."
}

ensure_process_started() {
  local pid="$1"
  local name="$2"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    fail "$name exited before OpenTag finished starting."
  fi
}

wait_for_stack_exit() {
  while true; do
    for name_and_pid in "Dispatcher:$DISPATCHER_PID" "Local daemon:$DAEMON_PID" "Lark ingress:$LARK_PID"; do
      local name="${name_and_pid%%:*}"
      local pid="${name_and_pid#*:}"
      if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" 2>/dev/null || true
        fail "$name exited. Check the log above for the underlying error."
      fi
    done
    sleep 1
  done
}

detect_executor() {
  if [[ -n "${OPENTAG_LARK_EXECUTOR:-}" ]]; then
    printf '%s' "$OPENTAG_LARK_EXECUTOR"
  else
    printf 'codex'
  fi
}

validate_executor() {
  case "$1" in
    echo|codex|claude-code|hermes)
      return
      ;;
    *)
      fail "Executor must be echo, codex, claude-code, or hermes."
      ;;
  esac
}

assert_executor_available() {
  case "$1" in
    codex|claude-code|echo)
      ;;
    hermes)
      require_command "${OPENTAG_HERMES_COMMAND:-hermes}"
      ;;
  esac
}

json_field() {
  local field="$1"
  FIELD="$field" node -e '
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
const jsonLine = input
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith("{") && line.endsWith("}"))
  .at(-1);
if (!jsonLine) {
  throw new Error("Lark Personal Agent registration did not return JSON credentials.");
}
const data = JSON.parse(jsonLine);
const value = data[process.env.FIELD];
if (typeof value === "string") process.stdout.write(value);
' <<< "$REGISTRATION_JSON"
}

saved_lark_field() {
  local field="$1"
  if [[ ! -f "$LARK_CONFIG_PATH" ]]; then
    return
  fi
  FIELD="$field" LARK_CONFIG_PATH="$LARK_CONFIG_PATH" node -e '
const { readFileSync } = require("node:fs");
let data;
try {
  data = JSON.parse(readFileSync(process.env.LARK_CONFIG_PATH, "utf8"));
} catch (error) {
  console.error(`Invalid saved Lark config at ${process.env.LARK_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const value = data[process.env.FIELD];
if (typeof value === "string") process.stdout.write(value);
'
}

register_lark_personal_agent() {
  (
    cd "$ROOT_DIR/apps/lark-events"
    node scripts/register-personal-agent.cjs
  )
}

write_lark_config() {
  mkdir -p "$STATE_DIR"
  LARK_CONFIG_PATH="$LARK_CONFIG_PATH" \
  LARK_APP_ID="$LARK_APP_ID" \
  LARK_APP_SECRET="$LARK_APP_SECRET" \
  LARK_DOMAIN="$LARK_DOMAIN" \
  LARK_BOT_OPEN_ID="${LARK_BOT_OPEN_ID:-}" \
  node <<'NODE'
const { closeSync, chmodSync, openSync, writeFileSync } = require("node:fs");

const config = {
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: process.env.LARK_DOMAIN,
  ...(process.env.LARK_BOT_OPEN_ID ? { botOpenId: process.env.LARK_BOT_OPEN_ID } : {}),
  savedAt: new Date().toISOString()
};

closeSync(openSync(process.env.LARK_CONFIG_PATH, "a", 0o600));
chmodSync(process.env.LARK_CONFIG_PATH, 0o600);
writeFileSync(process.env.LARK_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
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
const { closeSync, chmodSync, openSync, writeFileSync } = require("node:fs");

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

closeSync(openSync(process.env.CONFIG_PATH, "a", 0o600));
chmodSync(process.env.CONFIG_PATH, 0o600);
writeFileSync(process.env.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
}

run_opentagd() {
  local command_name="${1:-}"
  [[ -n "$command_name" ]] || fail "run_opentagd requires a command name."
  shift
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
CHECKOUT_INPUT="${OPENTAG_WORKSPACE_PATH:-$(read_with_default "Local path for this Project Target" "$DEFAULT_CHECKOUT")}"
CHECKOUT_PATH="$(absolute_path "$CHECKOUT_INPUT")"

[[ -d "$CHECKOUT_PATH" ]] || fail "Project Target path does not exist: $CHECKOUT_PATH"
git -C "$CHECKOUT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Project Target path must be a git checkout: $CHECKOUT_PATH"
CHECKOUT_PATH="$(canonical_path "$CHECKOUT_PATH")"

if [[ -n "${OPENTAG_REPO_OWNER:-}" && -n "${OPENTAG_REPO_NAME:-}" ]]; then
  REPO_PROVIDER="${OPENTAG_REPO_PROVIDER:-github}"
  REPO_OWNER="$OPENTAG_REPO_OWNER"
  REPO_NAME="$OPENTAG_REPO_NAME"
  log "Advanced repository target enabled for PR-capable workflows."
else
  PROJECT_TARGET_REF="$(local_project_ref "$CHECKOUT_PATH")"
  REPO_PROVIDER="${PROJECT_TARGET_REF%%:*}"
  PROJECT_TARGET_PATH="${PROJECT_TARGET_REF#*:}"
  REPO_OWNER="${PROJECT_TARGET_PATH%%/*}"
  REPO_NAME="${PROJECT_TARGET_PATH#*/}"
fi

BASE_BRANCH="${OPENTAG_BASE_BRANCH:-$(git -C "$CHECKOUT_PATH" branch --show-current 2>/dev/null || true)}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PUSH_REMOTE="${OPENTAG_PUSH_REMOTE:-origin}"

DETECTED_EXECUTOR="$(detect_executor)"
EXECUTOR="$(read_with_default "Executor for local runs (codex, claude-code, hermes, echo; choose codex for a bundled ACP agent)" "$DETECTED_EXECUTOR")"
validate_executor "$EXECUTOR"
assert_executor_available "$EXECUTOR"

SAVED_LARK_APP_ID="$(saved_lark_field appId)"
SAVED_LARK_APP_SECRET="$(saved_lark_field appSecret)"
SAVED_LARK_DOMAIN="$(saved_lark_field domain)"
SAVED_LARK_BOT_OPEN_ID="$(saved_lark_field botOpenId)"
EXPLICIT_LARK_SETUP="${OPENTAG_LARK_APP_SETUP:-}"
LARK_CONFIG_SOURCE=""

if [[ -n "${LARK_APP_ID:-}" && -n "${LARK_APP_SECRET:-}" ]]; then
  LARK_DOMAIN="${LARK_DOMAIN:-lark}"
  log "Using LARK_APP_ID and LARK_APP_SECRET from the environment."
  LARK_CONFIG_SOURCE="environment"
elif [[ -n "$SAVED_LARK_APP_ID" || -n "$SAVED_LARK_APP_SECRET" ]]; then
  if [[ -z "$SAVED_LARK_APP_ID" || -z "$SAVED_LARK_APP_SECRET" ]]; then
    if [[ -z "$EXPLICIT_LARK_SETUP" ]]; then
      fail "Saved Lark config at $LARK_CONFIG_PATH is incomplete. Delete it or set OPENTAG_LARK_APP_SETUP=scan or manual."
    fi
  elif [[ -z "$EXPLICIT_LARK_SETUP" ]]; then
    LARK_APP_ID="$SAVED_LARK_APP_ID"
    LARK_APP_SECRET="$SAVED_LARK_APP_SECRET"
    LARK_DOMAIN="${LARK_DOMAIN:-${SAVED_LARK_DOMAIN:-lark}}"
    LARK_BOT_OPEN_ID="${LARK_BOT_OPEN_ID:-$SAVED_LARK_BOT_OPEN_ID}"
    log "Using saved Lark app credentials from $LARK_CONFIG_PATH."
    LARK_CONFIG_SOURCE="saved"
  fi
fi

case "${LARK_DOMAIN:-}" in
  lark|feishu)
    ;;
  "")
    ;;
  *)
    fail "Lark domain must be lark or feishu."
    ;;
esac

if [[ -n "$LARK_CONFIG_SOURCE" ]]; then
  :
else
  DEFAULT_LARK_SETUP_MODE="${EXPLICIT_LARK_SETUP:-scan}"
  if [[ -n "${LARK_DOMAIN:-}" && -z "$EXPLICIT_LARK_SETUP" ]]; then
    DEFAULT_LARK_SETUP_MODE="manual"
  fi
  LARK_SETUP_MODE="$(read_with_default "Lark app setup (scan or manual)" "$DEFAULT_LARK_SETUP_MODE")"
  case "$LARK_SETUP_MODE" in
    scan)
      if [[ -n "${LARK_DOMAIN:-}" ]]; then
        fail "LARK_DOMAIN is detected during scan setup. Use OPENTAG_LARK_APP_SETUP=manual with LARK_DOMAIN for an existing app."
      fi
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
      LARK_DOMAIN="$(read_with_default "Lark / Feishu tenant (lark or feishu)" "${LARK_DOMAIN:-${SAVED_LARK_DOMAIN:-lark}}")"
      case "$LARK_DOMAIN" in
        lark|feishu)
          ;;
        *)
          fail "Lark domain must be lark or feishu."
          ;;
      esac
      LARK_APP_ID="$(read_with_default "LARK_APP_ID" "${LARK_APP_ID:-}")"
      LARK_APP_SECRET="$(read_secret_with_default "LARK_APP_SECRET" "${LARK_APP_SECRET:-}")"
      ;;
    *)
      fail "Lark app setup must be scan or manual."
      ;;
  esac
  LARK_CONFIG_SOURCE="setup"
fi

[[ -n "$LARK_APP_ID" ]] || fail "LARK_APP_ID is required."
[[ -n "$LARK_APP_SECRET" ]] || fail "LARK_APP_SECRET is required."
[[ -n "$LARK_DOMAIN" ]] || fail "LARK_DOMAIN is required."
case "$LARK_DOMAIN" in
  lark|feishu)
    ;;
  *)
    fail "Lark domain must be lark or feishu."
    ;;
esac

if [[ "$LARK_CONFIG_SOURCE" == "saved" ]]; then
  LARK_BOT_OPEN_ID="${LARK_BOT_OPEN_ID:-$SAVED_LARK_BOT_OPEN_ID}"
else
  LARK_BOT_OPEN_ID="${LARK_BOT_OPEN_ID:-}"
fi
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

if [[ "$LARK_CONFIG_SOURCE" != "environment" ]]; then
  write_lark_config
  log "Saved Lark app credentials to $LARK_CONFIG_PATH."
fi

PAIRING_TOKEN="${OPENTAG_PAIRING_TOKEN:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')}"
RUNNER_ID="${OPENTAG_RUNNER_ID:-runner_lark_local}"
DISPATCHER_PORT="$(choose_dispatcher_port)"
DISPATCHER_URL="http://localhost:$DISPATCHER_PORT"
DATABASE_PATH="${OPENTAG_DATABASE_PATH:-$STATE_DIR/opentag.db}"
DEFAULT_REPO="$REPO_PROVIDER:$REPO_OWNER/$REPO_NAME"

write_config

log
log "Starting OpenTag for Lark"
log "- Project Target: $REPO_NAME"
log "- Project Target path: $CHECKOUT_PATH"
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
  export NODE_OPTIONS='--conditions=development'
  exec corepack pnpm --filter @opentag/dispatcher-app dev
) &
DISPATCHER_PID=$!

ensure_process_started "$DISPATCHER_PID" "Dispatcher"
wait_for_dispatcher "$DISPATCHER_URL"

log "Registering local runner and binding the selected project..."
run_opentagd register-runner
run_opentagd bind-project-targets

log "Starting local daemon..."
(
  cd "$ROOT_DIR"
  export OPENTAG_CONFIG_PATH="$CONFIG_PATH"
  export NODE_OPTIONS='--conditions=development'
  exec corepack pnpm --filter @opentag/opentagd dev -- serve
) &
DAEMON_PID=$!
ensure_process_started "$DAEMON_PID" "Local daemon"

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
  export NODE_OPTIONS='--conditions=development'
  exec corepack pnpm --filter @opentag/lark-events dev
) &
LARK_PID=$!
ensure_process_started "$LARK_PID" "Lark ingress"

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
log "This script auto-connects the first Lark chat that messages the bot to this Project Target."
log
log "Expected AHA moment:"
log "1. This terminal shows the local daemon running the executor."
log "2. Lark replies with the agent's final result."
log
log "Press Ctrl-C to stop OpenTag."
wait_for_stack_exit
