#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Default port: read from ~/.openomni/config.json if available, else 3000
_config="${HOME}/.openomni/config.json"
if [[ -f "${_config}" ]] && command -v python3 >/dev/null 2>&1; then
  PORT="$(python3 -c "import json,sys; d=json.load(open('${_config}')); print(d.get('server',{}).get('port',3000))" 2>/dev/null || echo 3000)"
elif [[ -f "${_config}" ]]; then
  PORT="$(grep -o '"port":[[:space:]]*[0-9]*' "${_config}" | grep -o '[0-9]*$' || echo 3000)"
else
  PORT=3000
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ $# -lt 2 ]]; then
        echo "FAIL: OpenOmni is not responding on port ${PORT}"
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    *)
      echo "FAIL: OpenOmni is not responding on port ${PORT}"
      exit 1
      ;;
  esac
done

if response=$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health"); then
  if grep -q '"ok":true' <<<"${response}"; then
    echo "PASS: OpenOmni is healthy on port ${PORT}"
    exit 0
  fi
fi

echo "FAIL: OpenOmni is not responding on port ${PORT}"
exit 1
