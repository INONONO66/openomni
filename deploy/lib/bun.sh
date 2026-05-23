#!/usr/bin/env bash
set -euo pipefail

__deploy_bun_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__deploy_bun_repo_root="$(cd "${__deploy_bun_lib_dir}/../.." && pwd)"

__deploy_bun_required_version() {
  local package_manager

  package_manager="$(awk -F'"' '/"packageManager"/ {print $4; exit}' "${__deploy_bun_repo_root}/package.json")"
  printf '%s\n' "${package_manager#bun@}"
}

check_bun() {
  local required_version
  local installed_version

  if ! command -v bun >/dev/null 2>&1; then
    printf '%s\n' "Bun is not installed. Install it from https://bun.sh" >&2
    return 1
  fi

  required_version="$(__deploy_bun_required_version)"
  installed_version="$(bun --version)"

  if [[ "${installed_version}" != "${required_version}" ]]; then
    printf '%s\n' "Bun ${required_version} is required, found ${installed_version}. Install or switch versions at https://bun.sh" >&2
    return 1
  fi

  printf '%s\n' "Bun ${installed_version} is available" >&2
}
