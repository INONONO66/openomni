#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

source "${SCRIPT_DIR}/lib/log.sh"
source "${SCRIPT_DIR}/lib/platform.sh"
source "${SCRIPT_DIR}/lib/paths.sh"
source "${SCRIPT_DIR}/lib/bun.sh"
source "${SCRIPT_DIR}/lib/service.sh"

if [[ -f "${OPENOMNI_CONFIG}" ]]; then
  PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "${OPENOMNI_CONFIG}" | grep -o '[0-9]*$' || echo 3000)
else
  PORT=3000
fi

overall=0
passed=0

check_pass() {
  printf '[PASS] %s\n' "$*"
  passed=$((passed + 1))
}

check_fail() {
  printf '[FAIL] %s\n' "$*"
  overall=1
}

check_warn() {
  printf '[WARN] %s\n' "$*"
}

required_bun_version="$(__deploy_bun_required_version)"

if command -v bun >/dev/null 2>&1; then
  check_pass "Bun installed: $(command -v bun)"
else
  check_fail "Bun installed: not found"
fi

if command -v bun >/dev/null 2>&1; then
  installed_bun_version="$(bun --version)"
  if [[ "${installed_bun_version}" == "${required_bun_version}" ]]; then
    check_pass "Bun version: bun@${installed_bun_version}"
  else
    check_warn "Bun version: expected bun@${required_bun_version}, found bun@${installed_bun_version}"
  fi
else
  check_warn "Bun version: unavailable because bun is missing"
fi

if [[ -d "${OPENOMNI_HOME}" ]]; then
  check_pass "OPENOMNI_HOME exists: ${OPENOMNI_HOME}"
else
  check_warn "OPENOMNI_HOME exists: missing ${OPENOMNI_HOME}"
fi

if [[ -f "${OPENOMNI_CONFIG}" ]]; then
  check_pass "Config exists: ${OPENOMNI_CONFIG}"
else
  check_warn "Config exists: missing ${OPENOMNI_CONFIG}"
fi

if [[ -f "${OPENOMNI_CONFIG}" ]] && command -v bun >/dev/null 2>&1; then
  if bun -e "JSON.parse(require('fs').readFileSync('${OPENOMNI_CONFIG}','utf8'))" >/dev/null 2>&1; then
    check_pass "Config valid JSON: ${OPENOMNI_CONFIG}"
  else
    check_warn "Config valid JSON: invalid JSON in ${OPENOMNI_CONFIG}"
  fi
else
  check_warn "Config valid JSON: skipped because config or bun is unavailable"
fi

db_parent_dir="$(dirname "${OPENOMNI_DB}")"
if [[ -d "${db_parent_dir}" && -w "${db_parent_dir}" ]]; then
  check_pass "DB path writable: ${db_parent_dir}"
else
  check_warn "DB path writable: parent directory is not writable (${db_parent_dir})"
fi

if [[ -f "${SERVICE_DIR}/${SERVICE_UNIT}" ]]; then
  check_pass "Service unit file exists: ${SERVICE_DIR}/${SERVICE_UNIT}"
else
  check_fail "Service unit file exists: missing ${SERVICE_DIR}/${SERVICE_UNIT}"
fi

if is_service_active >/dev/null 2>&1; then
  check_pass "Service active: ${SERVICE_NAME}"
else
  check_fail "Service active: ${SERVICE_NAME} is not running"
fi

if curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  check_pass "Health endpoint: http://127.0.0.1:${PORT}/health"
else
  check_fail "Health endpoint: http://127.0.0.1:${PORT}/health did not respond"
fi

if is_service_active >/dev/null 2>&1; then
  check_pass "Port conflict: skipped because ${SERVICE_NAME} is active"
else
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    check_warn "Port conflict: port ${PORT} is already in use"
  else
    check_pass "Port conflict: port ${PORT} is free"
  fi
fi

printf '%d/10 checks passed\n' "${passed}"

exit "${overall}"
