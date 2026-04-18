#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ROOT_DIR}/.runtime/local-origin"
STATE_FILE="${STATE_DIR}/state.json"
PID_FILE="${STATE_DIR}/server.pid"
TUNNEL_PID_FILE="${STATE_DIR}/tunnel.pid"

log() {
  printf '[local] %s\n' "$*"
}

log "process"
if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" >/dev/null 2>&1; then
    log "local yt-dlp bridge pid ${pid} is running"
  else
    log "local yt-dlp bridge pid ${pid} is NOT running"
  fi
else
  log "local yt-dlp bridge is not started (no pid file)"
fi

if [[ -f "${TUNNEL_PID_FILE}" ]]; then
  tunnel_pid="$(cat "${TUNNEL_PID_FILE}")"
  if kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
    log "cloudflared tunnel pid ${tunnel_pid} is running"
  else
    log "cloudflared tunnel pid ${tunnel_pid} is NOT running"
  fi
else
  log "cloudflared tunnel is not started (no pid file)"
fi

log ""
log "state"
if [[ -f "${STATE_FILE}" ]]; then
  cat "${STATE_FILE}"
else
  log "no state file found"
fi
