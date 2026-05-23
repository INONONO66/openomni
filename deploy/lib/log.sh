#!/usr/bin/env bash
set -euo pipefail

__deploy_log_reset=""
__deploy_log_blue=""
__deploy_log_green=""
__deploy_log_yellow=""
__deploy_log_red=""

if [[ -t 2 ]]; then
  __deploy_log_reset=$'\033[0m'
  __deploy_log_blue=$'\033[34m'
  __deploy_log_green=$'\033[32m'
  __deploy_log_yellow=$'\033[33m'
  __deploy_log_red=$'\033[31m'
fi

log_info() {
  printf '%b[INFO]%b %s\n' "${__deploy_log_blue}" "${__deploy_log_reset}" "$*" >&2
}

log_success() {
  printf '%b[OK]%b %s\n' "${__deploy_log_green}" "${__deploy_log_reset}" "$*" >&2
}

log_warn() {
  printf '%b[WARN]%b %s\n' "${__deploy_log_yellow}" "${__deploy_log_reset}" "$*" >&2
}

log_error() {
  printf '%b[ERROR]%b %s\n' "${__deploy_log_red}" "${__deploy_log_reset}" "$*" >&2
}
