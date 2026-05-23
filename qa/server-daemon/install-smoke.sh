#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${SCRIPT_DIR}"

_config="${HOME}/.openomni/config.json"
if [[ -f "${_config}" ]]; then
  PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "${_config}" | grep -o '[0-9]*$' || echo 3000)
else
  PORT=3000
fi

overall=0
passed=0

smoke_pass() {
  printf '[PASS] %s\n' "$1"
  passed=$((passed + 1))
}

smoke_fail() {
  printf '[FAIL] %s\n' "$1"
  overall=1
}

check_service_unit() {
  [ -f "${HOME}/.config/systemd/user/openomni.service" ]
}

check_service_active() {
  systemctl --user is-active --quiet openomni
}

check_health_endpoint() {
  curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'
}

check_config_file() {
  [ -f "${HOME}/.openomni/config.json" ]
}

check_db_path() {
  local db_dir
  db_dir="$(dirname "${HOME}/.openomni/storage.db")"
  [ -f "${HOME}/.openomni/storage.db" ] || [ -w "${db_dir}" ]
}

if check_service_unit; then
  smoke_pass "Service unit file registered"
else
  smoke_fail "Service unit file registered"
fi

if check_service_active; then
  smoke_pass "Service active"
else
  smoke_fail "Service active"
fi

if check_health_endpoint; then
  smoke_pass "Health endpoint OK"
else
  smoke_fail "Health endpoint OK"
fi

if check_config_file; then
  smoke_pass "Config file exists"
else
  smoke_fail "Config file exists"
fi

if check_db_path; then
  smoke_pass "DB file exists or path writable"
else
  smoke_fail "DB file exists or path writable"
fi

printf '%s/5 checks passed\n' "$passed"

exit "$overall"
