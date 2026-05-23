#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

source "${SCRIPT_DIR}/lib/log.sh"

VERSION="${1:-}"

if [[ -z "${VERSION}" ]]; then
  log_error "Usage: ./deploy/release.sh v0.1.0"
  exit 1
fi

if ! [[ "${VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_error "Version must be in format vX.Y.Z"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log_error "Working tree is not clean. Commit or stash changes first."
  exit 1
fi

if [[ -n "$(git tag -l "${VERSION}")" ]]; then
  log_error "Tag ${VERSION} already exists"
  exit 1
fi

git tag -a "${VERSION}" -m "Release ${VERSION}"

log_success "Tagged ${VERSION}"
log_info "To publish: git push origin ${VERSION}"
