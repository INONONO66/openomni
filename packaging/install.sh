#!/usr/bin/env bash
set -euo pipefail

UNIT_FILE="$(dirname "$0")/systemd/openomni.service"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

echo "Installing OpenOmni daemon..."
mkdir -p "$SYSTEMD_USER_DIR"
cp "$UNIT_FILE" "$SYSTEMD_USER_DIR/openomni@.service"
systemctl --user daemon-reload
systemctl --user enable "openomni@$(whoami)"
systemctl --user start "openomni@$(whoami)"
echo "OpenOmni daemon installed and started."
echo "Check status: systemctl --user status openomni@$(whoami)"
echo "View logs: journalctl --user -u openomni@$(whoami) -f"
