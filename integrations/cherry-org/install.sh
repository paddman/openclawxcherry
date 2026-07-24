#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
MAIN_WORKSPACE="${OPENCLAW_WORKSPACE_DIR:-$STATE_DIR/workspace}"
RABBIT_WORKSPACE="$STATE_DIR/workspace-rabbit-boss"
CLEVEL_WORKSPACE="$STATE_DIR/workspace-c-level"
INSTALL_ROOT="${CHERRY_ORG_HOME:-$HOME/.local/share/cherry-org}"
BIN_DIR="${CHERRY_ORG_BIN_DIR:-$HOME/.local/bin}"
ENV_FILE="$STATE_DIR/.env"
VENV_DIR="$INSTALL_ROOT/venv"
SERVICE_NAME="cherry-c-level.service"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '[cherry-org] %s\n' "$*"; }
die() { printf '[cherry-org] ERROR: %s\n' "$*" >&2; exit 1; }

command -v openclaw >/dev/null 2>&1 || die "openclaw CLI is not installed"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v git >/dev/null 2>&1 || die "git is required"

mkdir -p "$STATE_DIR" "$INSTALL_ROOT" "$BIN_DIR" "$MAIN_WORKSPACE" "$RABBIT_WORKSPACE" "$CLEVEL_WORKSPACE"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

ensure_env() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if ! grep -q '^DEEPSEEK_API_KEY=' "$ENV_FILE"; then
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    ensure_env DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
  else
    die "Set DEEPSEEK_API_KEY in the environment or $ENV_FILE before installation"
  fi
fi

if grep -q '^C_LEVEL_API_TOKEN=' "$ENV_FILE"; then
  C_LEVEL_API_TOKEN="$(grep '^C_LEVEL_API_TOKEN=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
else
  C_LEVEL_API_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  ensure_env C_LEVEL_API_TOKEN "$C_LEVEL_API_TOKEN"
fi

ensure_env C_LEVEL_API_URL "http://127.0.0.1:8787"
ensure_env C_LEVEL_API_HOST "127.0.0.1"
ensure_env C_LEVEL_API_PORT "8787"
ensure_env OPENAI_BASE_URL "https://api.deepseek.com"
ensure_env OPENAI_REASONING_MODEL "deepseek-v4-pro"
ensure_env OPENAI_FAST_MODEL "deepseek-v4-flash"
ensure_env AGENTS_CONFIG "config/agents.yaml"
ensure_env COMPANY_CONFIG "config/company.yaml"

if [[ -n "${C_LEVEL_SOURCE_DIR:-}" ]]; then
  CLEVEL_DIR="$(cd "$C_LEVEL_SOURCE_DIR" && pwd)"
elif [[ -d "$(dirname "$REPO_ROOT")/C-level/.git" ]]; then
  CLEVEL_DIR="$(cd "$(dirname "$REPO_ROOT")/C-level" && pwd)"
else
  CLEVEL_DIR="$INSTALL_ROOT/C-level"
  if [[ -d "$CLEVEL_DIR/.git" ]]; then
    log "Updating C-Level repository"
    git -C "$CLEVEL_DIR" pull --ff-only
  else
    log "Cloning private C-Level repository"
    git clone "${C_LEVEL_REPO_URL:-https://github.com/paddman/C-level.git}" "$CLEVEL_DIR" || \
      die "Cannot clone C-Level. Configure GitHub credentials or set C_LEVEL_SOURCE_DIR."
  fi
fi

[[ -f "$CLEVEL_DIR/requirements.txt" ]] || die "Invalid C-Level source: $CLEVEL_DIR"
[[ -f "$CLEVEL_DIR/config/company.yaml" ]] || cp "$CLEVEL_DIR/config/company.example.yaml" "$CLEVEL_DIR/config/company.yaml"

log "Installing C-Level Python runtime"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$CLEVEL_DIR/requirements.txt"

log "Installing cherry-org command"
install -m 0755 "$SCRIPT_DIR/bin/cherry-org" "$BIN_DIR/cherry-org"

copy_workspace_file() {
  local source="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  if [[ -f "$destination" ]] && ! cmp -s "$source" "$destination"; then
    cp "$destination" "${destination}.bak.${TIMESTAMP}"
  fi
  cp "$source" "$destination"
}

log "Installing Cherry, Rabbit Boss, and C-Level workspaces"
copy_workspace_file "$SCRIPT_DIR/workspaces/cherry/SOUL.md" "$MAIN_WORKSPACE/SOUL.md"
copy_workspace_file "$SCRIPT_DIR/workspaces/cherry/AGENTS.md" "$MAIN_WORKSPACE/AGENTS.md"
copy_workspace_file "$SCRIPT_DIR/workspaces/rabbit-boss/SOUL.md" "$RABBIT_WORKSPACE/SOUL.md"
copy_workspace_file "$SCRIPT_DIR/workspaces/rabbit-boss/AGENTS.md" "$RABBIT_WORKSPACE/AGENTS.md"
copy_workspace_file "$SCRIPT_DIR/workspaces/c-level/SOUL.md" "$CLEVEL_WORKSPACE/SOUL.md"
copy_workspace_file "$SCRIPT_DIR/workspaces/c-level/AGENTS.md" "$CLEVEL_WORKSPACE/AGENTS.md"

for workspace in "$MAIN_WORKSPACE" "$RABBIT_WORKSPACE" "$CLEVEL_WORKSPACE"; do
  mkdir -p "$workspace/skills/c-level"
  cp "$SCRIPT_DIR/skills/c-level/SKILL.md" "$workspace/skills/c-level/SKILL.md"
done

log "Installing official DeepSeek provider"
if ! openclaw models list --all --provider deepseek >/dev/null 2>&1; then
  openclaw plugins install @openclaw/deepseek-provider
fi

AGENTS_JSON="$(openclaw agents list --json 2>/dev/null || printf '[]')"
if ! grep -q '"id"[[:space:]]*:[[:space:]]*"rabbit-boss"' <<<"$AGENTS_JSON"; then
  openclaw agents add rabbit-boss \
    --workspace "$RABBIT_WORKSPACE" \
    --model deepseek/deepseek-v4-pro \
    --non-interactive
fi

AGENTS_JSON="$(openclaw agents list --json 2>/dev/null || printf '[]')"
if ! grep -q '"id"[[:space:]]*:[[:space:]]*"c-level"' <<<"$AGENTS_JSON"; then
  openclaw agents add c-level \
    --workspace "$CLEVEL_WORKSPACE" \
    --model deepseek/deepseek-v4-pro \
    --non-interactive
fi

log "Configuring agent identities and delegation"
openclaw agents set-identity --agent main --name Cherry --theme "AI secretary and front office" --emoji "🍒" >/dev/null
openclaw agents set-identity --agent rabbit-boss --name "Rabbit Boss" --theme "execution commander" --emoji "🐇" >/dev/null
openclaw agents set-identity --agent c-level --name "C-Level" --theme "board and executive council" --emoji "🏢" >/dev/null

openclaw config set 'agents.entries.main.model' 'deepseek/deepseek-v4-flash'
openclaw config set 'agents.entries.main.subagents.allowAgents' '["rabbit-boss","c-level"]' --strict-json
openclaw config set 'agents.entries.main.subagents.requireAgentId' true --strict-json
openclaw config set 'agents.entries.main.tools.profile' 'messaging'
openclaw config set 'agents.entries.rabbit-boss.subagents.allowAgents' '["c-level"]' --strict-json
openclaw config set 'agents.entries.rabbit-boss.subagents.requireAgentId' true --strict-json
openclaw config set 'agents.entries.rabbit-boss.tools.profile' 'coding'
openclaw config set 'agents.entries.c-level.tools.profile' 'minimal'
openclaw config set 'tools.exec.mode' 'auto'
openclaw config set 'tools.exec.host' 'gateway'

# Allow only the narrow localhost bridge executable, not python/bash interpreters.
openclaw approvals allowlist add --agent '*' "$BIN_DIR/cherry-org" >/dev/null || true

log "Installing C-Level localhost service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=Cherry C-Level Organization API
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$CLEVEL_DIR
EnvironmentFile=-$ENV_FILE
Environment=PYTHONPATH=$CLEVEL_DIR/src
ExecStart=$VENV_DIR/bin/python -m c_level.api
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
else
  PID_FILE="$INSTALL_ROOT/cherry-c-level.pid"
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "C-Level API already running"
  else
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    PYTHONPATH="$CLEVEL_DIR/src" nohup "$VENV_DIR/bin/python" -m c_level.api \
      > "$INSTALL_ROOT/cherry-c-level.log" 2>&1 &
    echo $! > "$PID_FILE"
  fi
fi

openclaw config validate
openclaw gateway restart

log "Verifying integration"
for _ in $(seq 1 30); do
  if "$BIN_DIR/cherry-org" health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

"$BIN_DIR/cherry-org" health
openclaw agents list --bindings
openclaw skills list

cat <<EOF

Cherry Organization installed.

Test commands:
  $BIN_DIR/cherry-org route "งบสร้างแอปใหม่ใครรับผิดชอบ"
  $BIN_DIR/cherry-org meeting "วางแผนเปิดตัว AI Twin ภายใน 30 วัน"
  openclaw agent --message "เชอรี่ ช่วยให้ Rabbit Boss วางแผนเปิดตัว AI Twin แล้วขอมติ C-Level"

Main agent: Cherry (DeepSeek V4 Flash)
Execution agent: Rabbit Boss (DeepSeek V4 Pro)
Decision agent: C-Level (DeepSeek V4 Pro)
EOF
