#!/usr/bin/env bash
set -euo pipefail

echo "Uninstalling OpenOmni daemon..."
systemctl --user stop "openomni@$(whoami)" 2>/dev/null || true
systemctl --user disable "openomni@$(whoami)" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/openomni@.service"
systemctl --user daemon-reload
echo "OpenOmni daemon uninstalled."
