#!/usr/bin/env bash
# Refresh PlayaEvents into data/playa-events-2026.json and paywall.sqlite.
# Walks every day (date-nav) and any listing Next-page links, then re-imports.
#
# Usage:
#   ./scripts/refresh-playa-events.sh           # full scrape + import
#   ./scripts/refresh-playa-events.sh --only-new # reuse prior details; fetch new ids only
#   ./scripts/refresh-playa-events.sh install      # install/enable 4am daily timer
#   ./scripts/refresh-playa-events.sh status
#   ./scripts/refresh-playa-events.sh uninstall

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

YEAR="${PLAYA_YEAR:-2026}"
OUT="${PLAYA_OUT:-$ROOT/data/playa-events-${YEAR}.json}"
DB="${PLAYA_DB:-$ROOT/data/paywall.sqlite}"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/playa-events-refresh.log"
UNIT_SERVICE="playa-events-refresh.service"
UNIT_TIMER="playa-events-refresh.timer"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PYTHON="${PYTHON:-/usr/bin/python3}"

mkdir -p "$LOG_DIR" "$(dirname "$OUT")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG_FILE"
}

run_refresh() {
  local only_new=0
  if [[ "${1:-}" == "--only-new" ]]; then
    only_new=1
  fi

  log "Starting PlayaEvents refresh (year=$YEAR only_new=$only_new)"
  local scrape_args=(--year "$YEAR" --out "$OUT")
  if [[ "$only_new" -eq 1 ]]; then
    scrape_args+=(--only-new)
  fi

  "$PYTHON" "$ROOT/scripts/scrape-playa-events.py" "${scrape_args[@]}"
  "$PYTHON" "$ROOT/scripts/import-playa-events.py" --json "$OUT" --db "$DB"
  log "Refresh complete → $OUT"
}

install_units() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$UNIT_SERVICE" <<EOF
[Unit]
Description=Refresh Burning Man PlayaEvents into camp schedule DB
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${ROOT}
Environment=PLAYA_YEAR=${YEAR}
Environment=PLAYA_OUT=${OUT}
Environment=PLAYA_DB=${DB}
ExecStart=${ROOT}/scripts/refresh-playa-events.sh --only-new
Nice=10

[Install]
WantedBy=default.target
EOF

  cat >"$UNIT_DIR/$UNIT_TIMER" <<EOF
[Unit]
Description=Daily 4am PlayaEvents scrape (America/Los_Angeles)

[Timer]
OnCalendar=*-*-* 04:00:00 America/Los_Angeles
Persistent=true
Unit=${UNIT_SERVICE}

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_TIMER"
  systemctl --user status "$UNIT_TIMER" --no-pager || true
  echo "Installed: daily refresh at 4:00 America/Los_Angeles"
  echo "Logs: $LOG_FILE"
}

uninstall_units() {
  systemctl --user disable --now "$UNIT_TIMER" 2>/dev/null || true
  systemctl --user disable --now "$UNIT_SERVICE" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT_TIMER" "$UNIT_DIR/$UNIT_SERVICE"
  systemctl --user daemon-reload
  echo "Uninstalled playa-events-refresh timer/service"
}

status_units() {
  systemctl --user status "$UNIT_TIMER" --no-pager || true
  systemctl --user list-timers "$UNIT_TIMER" --no-pager || true
  if [[ -f "$LOG_FILE" ]]; then
    echo "---- last log lines ----"
    tail -n 20 "$LOG_FILE"
  fi
}

cmd="${1:-}"
case "$cmd" in
  install) install_units ;;
  uninstall) uninstall_units ;;
  status) status_units ;;
  --only-new) run_refresh --only-new ;;
  ""|run) run_refresh ;;
  *)
    echo "Usage: $0 [run|--only-new|install|status|uninstall]" >&2
    exit 2
    ;;
esac
