#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

source "${SCRIPT_DIR}/lib/log.sh"
source "${SCRIPT_DIR}/lib/platform.sh"
source "${SCRIPT_DIR}/lib/paths.sh"
source "${SCRIPT_DIR}/lib/bun.sh"
source "${SCRIPT_DIR}/lib/service.sh"

PORT=3000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      shift
      if [[ $# -eq 0 ]]; then
        log_error "Missing value for --port"
        exit 1
      fi
      PORT="$1"
      ;;
    *)
      log_error "Unknown argument: $1"
      exit 1
      ;;
  esac
  shift
done

detect_os
check_bun

[ -d "${OPENOMNI_APP_DIR}" ] || { log_error "Not installed. Run deploy/install.sh first."; exit 1; }

log_info "Pulling latest changes..."
git -C "${OPENOMNI_APP_DIR}" pull --ff-only

log_info "Installing dependencies..."
bun install --frozen-lockfile --cwd "${OPENOMNI_APP_DIR}"

log_info "Building..."
bun run --cwd "${OPENOMNI_APP_DIR}" build

stop_service
start_service

for _ in $(seq 1 15); do
  if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null; then
    log_success "OpenOmni updated and running"
    exit 0
  fi

  sleep 1
done

log_error "Health check failed after restart"
exit 1
