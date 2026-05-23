#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="openomni"
SERVICE_UNIT="${SERVICE_NAME}.service"

__deploy_service_detect_os() {
  case "$(uname -s)" in
    Darwin)
      OS="macos"
      INIT_SYSTEM="launchd"
      ;;
    Linux)
      OS="linux"
      INIT_SYSTEM="systemd"
      ;;
    *)
      OS="linux"
      INIT_SYSTEM="none"
      ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64)
      ARCH="x86_64"
      ;;
    arm64 | aarch64)
      ARCH="arm64"
      ;;
    *)
      ARCH="x86_64"
      ;;
  esac

  export OS INIT_SYSTEM ARCH
}

__deploy_service_init_platform() {
  if [[ -z "${OS:-}" || -z "${INIT_SYSTEM:-}" || -z "${ARCH:-}" ]]; then
    __deploy_service_detect_os
  fi
}

__deploy_service_mac_stub() {
  printf '%s\n' "macOS launchd support coming soon — use launchctl manually or wait for full launchd wiring" >&2
  return 1
}

install_service() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user enable "${SERVICE_UNIT}"
}

uninstall_service() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user disable --now "${SERVICE_UNIT}"
}

start_service() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user start "${SERVICE_UNIT}"
}

stop_service() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user stop "${SERVICE_UNIT}"
}

is_service_active() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user is-active --quiet "${SERVICE_UNIT}"
}

service_status() {
  __deploy_service_init_platform

  if [[ "${OS}" == "macos" ]]; then
    __deploy_service_mac_stub || return 1
  fi

  systemctl --user status "${SERVICE_UNIT}"
}
