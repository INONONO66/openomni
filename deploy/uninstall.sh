#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

source "${SCRIPT_DIR}/lib/log.sh"
source "${SCRIPT_DIR}/lib/platform.sh"
source "${SCRIPT_DIR}/lib/paths.sh"
source "${SCRIPT_DIR}/lib/service.sh"

PURGE=false
YES=false

while (($# > 0)); do
  case "$1" in
    --purge)
      PURGE=true
      ;;
    --yes)
      YES=true
      ;;
    -h | --help)
      printf 'Usage: %s [--purge] [--yes]\n' "$0"
      exit 0
      ;;
    *)
      log_error "Unknown flag: $1"
      exit 1
      ;;
  esac
  shift
done

detect_os

stop_service || true
uninstall_service || true

rm -f "${SERVICE_DIR}/openomni.service"
systemctl --user daemon-reload || true

if [[ "${PURGE}" == true ]]; then
  if [[ "${YES}" != true ]]; then
    printf 'This will delete %s and all data. Continue? [y/N] ' "${OPENOMNI_HOME}"
    read -r answer
    case "${answer}" in
      y|Y)
        ;;
      *)
        log_info "Aborted"
        exit 0
        ;;
    esac
  fi

  rm -rf "${OPENOMNI_HOME}"
  log_success "Data purged"
else
  log_info "Data preserved at ${OPENOMNI_HOME}"
fi

log_success "OpenOmni uninstalled"
