#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

PORT=3000

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
