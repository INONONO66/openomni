#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

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

if [ ! -f "${HOME}/.config/systemd/user/openomni.service" ]; then
  smoke_pass "Service unit not registered"
else
  smoke_fail "Service unit not registered"
fi

if ! systemctl --user is-active --quiet openomni 2>/dev/null; then
  smoke_pass "Service not active"
else
  smoke_fail "Service not active"
fi

if ! curl -sf --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  smoke_pass "Health endpoint not responding"
else
  smoke_fail "Health endpoint not responding"
fi

printf '%s/3 checks passed\n' "$passed"

exit "$overall"
