#!/usr/bin/env bash
# Keep the local paywall reachable on the host network after code edits.
#
# Root cause this fixes:
# - Cursor agent shells often start the app inside cursorsandbox → browser
#   "Unable to connect" even when logs say "listening"
# - `npm` is aliased to `socket npm`, which wraps/hangs the process
# - Agents kill/restart on every edit; tsx watch reloads in-place instead
#
# Preferred path: systemd --user unit (escapes agent sandbox).
# Fallback: nohup node+tsx watch (must be run outside sandbox).
#
# Usage:
#   ./scripts/ensure-server.sh          # start or heal if needed
#   ./scripts/ensure-server.sh status
#   ./scripts/ensure-server.sh stop
#   ./scripts/ensure-server.sh restart
#   ./scripts/ensure-server.sh install  # install/enable user systemd unit

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
URL="http://${HOST}:${PORT}/"
PID_FILE="$ROOT/data/dev-server.pid"
LOG_FILE="$ROOT/data/dev-server.log"
UNIT_NAME="starlinkpayment-dev.service"
UNIT_SRC="$ROOT/scripts/starlinkpayment-dev.service"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${UNIT_NAME}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
TSX_CLI="$ROOT/node_modules/tsx/dist/cli.mjs"

mkdir -p "$ROOT/data"

health_ok() {
  curl -fsS --max-time 2 -o /dev/null "$URL" 2>/dev/null
}

unit_installed() {
  [[ -f "$UNIT_DST" ]]
}

unit_active() {
  systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null
}

server_pgrep() {
  # Match this project's tsx/node index processes only.
  pgrep -f "${ROOT}/node_modules/tsx/dist/.*src/index\\.ts" 2>/dev/null || true
}

stop_orphans() {
  local p
  for p in $(server_pgrep); do
    kill -9 "$p" 2>/dev/null || true
  done
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(tr -d '[:space:]' <"$PID_FILE" || true)"
    if [[ -n "${pid:-}" ]]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  sleep 0.3
}

install_unit() {
  mkdir -p "$(dirname "$UNIT_DST")"
  # Rewrite WorkingDirectory / paths for this checkout.
  sed \
    -e "s|/home/jaybird/jayprograms/starlinkpayment|${ROOT}|g" \
    "$UNIT_SRC" >"$UNIT_DST"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME"
  echo "installed user unit: $UNIT_DST"
}

start_via_systemd() {
  systemctl --user restart "$UNIT_NAME"
}

start_via_nohup() {
  if [[ ! -x "$NODE_BIN" ]]; then
    echo "error: node not found at $NODE_BIN" >&2
    exit 1
  fi
  if [[ ! -f "$TSX_CLI" ]]; then
    echo "error: tsx missing — run: /usr/bin/npm install" >&2
    exit 1
  fi
  nohup "$NODE_BIN" "$TSX_CLI" watch src/index.ts \
    >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  disown "$(tr -d '[:space:]' <"$PID_FILE")" 2>/dev/null || true
}

wait_healthy() {
  local i
  for i in $(seq 1 40); do
    if health_ok; then
      echo "ok: paywall healthy at $URL"
      return 0
    fi
    sleep 0.25
  done
  echo "error: server did not become healthy at $URL" >&2
  echo "---- last log lines ----" >&2
  tail -n 50 "$LOG_FILE" >&2 || true
  if unit_installed; then
    systemctl --user status "$UNIT_NAME" --no-pager >&2 || true
  fi
  exit 1
}

start_server() {
  if unit_installed; then
    start_via_systemd
  else
    echo "note: user systemd unit not installed; using nohup fallback"
    echo "      run: $0 install   (recommended — survives agent sandbox)"
    start_via_nohup
  fi
  wait_healthy
}

stop_server() {
  if unit_installed; then
    systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
  fi
  stop_orphans
}

cmd="${1:-ensure}"

case "$cmd" in
  install)
    install_unit
    stop_orphans
    start_via_systemd
    wait_healthy
    ;;
  status)
    if health_ok; then
      echo "healthy $URL"
      if unit_installed; then
        systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true
      fi
      exit 0
    fi
    echo "unhealthy $URL"
    exit 1
    ;;
  stop)
    stop_server
    echo "stopped"
    ;;
  restart)
    stop_server
    start_server
    ;;
  ensure|"")
    if health_ok; then
      echo "ok: already healthy at $URL"
      exit 0
    fi
    echo "healing: $URL not reachable — restarting (tsx watch, host network)"
    stop_server
    start_server
    ;;
  *)
    echo "usage: $0 [ensure|status|stop|restart|install]" >&2
    exit 2
    ;;
esac
