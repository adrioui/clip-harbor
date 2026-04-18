#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.runtime/local-origin"
PID_FILE="${STATE_DIR}/server.pid"
TUNNEL_PID_FILE="${STATE_DIR}/tunnel.pid"

log() {
  printf '[local] %s\n' "$*"
}

log "stopping local services"

for pid_file in "${PID_FILE}" "${TUNNEL_PID_FILE}"; do
  if [[ -f "${pid_file}" ]]; then
    pid="$(cat "${pid_file}")"
    if kill -0 "${pid}" >/dev/null 2>&1; then
      log "stopping pid ${pid}"
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi
done

log "local services stopped"
