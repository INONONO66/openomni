#!/usr/bin/env bash
set -euo pipefail

detect_os() {
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
