#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

source "${SCRIPT_DIR}/lib/log.sh"
source "${SCRIPT_DIR}/lib/platform.sh"
source "${SCRIPT_DIR}/lib/paths.sh"
source "${SCRIPT_DIR}/lib/bun.sh"
source "${SCRIPT_DIR}/lib/service.sh"

print_status_commands() {
  printf '%s\n' "systemctl --user status openomni"
  printf '%s\n' "journalctl --user -u openomni -f"
}

log_info "Installing OpenOmni"

detect_os

if [[ "${OS}" == "macos" ]]; then
  log_info "macOS launchd support coming soon — service install skipped"
  exit 0
fi

if [[ "${INIT_SYSTEM}" != "systemd" ]]; then
  log_error "systemd required"
  exit 1
fi

if ! check_bun; then
  exit 1
fi

if [[ -e "${OPENOMNI_APP_DIR}" ]] && is_service_active; then
  log_success "Already installed and running"
  print_status_commands
  exit 0
fi

mkdir -p "${OPENOMNI_HOME}"
mkdir -p "${SERVICE_DIR}"

ln -sfn "$(cd "${SCRIPT_DIR}/.." && pwd)" "${OPENOMNI_APP_DIR}"

(
  cd "${OPENOMNI_APP_DIR}"
  bun install --frozen-lockfile
  bun run build
)

if [[ ! -f "${OPENOMNI_CONFIG}" ]]; then
  cp "${SCRIPT_DIR}/templates/config.json" "${OPENOMNI_CONFIG}"
fi

if [[ ! -f "${OPENOMNI_ENV}" ]]; then
  cp "${SCRIPT_DIR}/templates/env.example" "${OPENOMNI_ENV}"
fi

cp "${SCRIPT_DIR}/systemd/openomni.service" "${SERVICE_DIR}/openomni.service"

systemctl --user daemon-reload
systemctl --user enable openomni
start_service

PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "${OPENOMNI_CONFIG}" | grep -o '[0-9]*$' || echo 3000)

health_ok=0
for _ in {1..15}; do
  if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null; then
    health_ok=1
    break
  fi
  sleep 1
done

if [[ "${health_ok}" != "1" ]]; then
  log_error "OpenOmni health check failed on port ${PORT}"
  exit 1
fi

log_success "OpenOmni installed and running"
print_status_commands
