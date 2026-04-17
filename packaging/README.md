# OpenOmni Daemon Packaging

Systemd unit and scripts for running the OpenOmni coordinator daemon as a persistent user service on Linux.

## Prerequisites

- Linux with systemd (kernel 4.1+, systemd 219+)
- [Bun](https://bun.sh) installed at `/usr/local/bin/bun`
- `loginctl enable-linger <username>` run once so the user service survives logout

## Installation

```bash
chmod +x packaging/install.sh packaging/uninstall.sh
./packaging/install.sh
```

The script:
1. Copies `openomni@.service` to `~/.config/systemd/user/`
2. Runs `systemctl --user daemon-reload`
3. Enables and starts `openomni@<username>`

## Configuration

The daemon reads configuration from environment variables. Override them by creating a drop-in:

```bash
mkdir -p ~/.config/systemd/user/openomni@.service.d
cat > ~/.config/systemd/user/openomni@.service.d/override.conf << 'EOF'
[Service]
Environment=OPENOMNI_WS_PORT=9999
Environment=OPENOMNI_HEALTH_PORT=9998
Environment=OPENOMNI_IPC_SOCKET=/tmp/openomni-coordinator.sock
Environment=OPENOMNI_DRAIN_TIMEOUT_MS=60000
Environment=OPENOMNI_LOG_LEVEL=debug
EOF
systemctl --user daemon-reload
systemctl --user restart openomni@$(whoami)
```

### Secrets

Store API keys in `~/.openomni/secrets.json` (mode 600). The daemon reads this file at startup:

```bash
mkdir -p ~/.openomni
chmod 700 ~/.openomni
cat > ~/.openomni/secrets.json << 'EOF'
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "OPENAI_API_KEY": "sk-..."
}
EOF
chmod 600 ~/.openomni/secrets.json
```

## Monitoring

```bash
# Service status
systemctl --user status openomni@$(whoami)

# Live logs
journalctl --user -u openomni@$(whoami) -f

# Logs since last boot
journalctl --user -u openomni@$(whoami) -b

# Health endpoint (HTTP)
curl http://localhost:9998/health
```

## Upgrade

```bash
# Pull new coordinator binary/source, then:
systemctl --user restart openomni@$(whoami)
```

The daemon handles `SIGTERM` with a graceful drain: it waits up to 60 seconds for active runs to finish before exiting. Systemd sends `SIGTERM` on `restart`, so in-flight work is not dropped.

## Uninstall

```bash
./packaging/uninstall.sh
```

This stops the service, disables it, removes the unit file, and reloads the daemon.

## Troubleshooting

**Service fails to start**

Check that Bun is at `/usr/local/bin/bun`:
```bash
which bun
# If different path, create a symlink or update ExecStart in the unit file
```

**Linger not enabled**

Without linger, the user service stops when you log out:
```bash
loginctl enable-linger $(whoami)
```

**Port conflicts**

If 9999 or 9998 are taken, override them via the drop-in config above.
