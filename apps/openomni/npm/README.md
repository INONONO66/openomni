# OpenOmni

Single-Owner Agent OS — one permanent Resident agent, running 24/7 on your own machine.

OpenOmni runs on the [Bun](https://bun.sh) runtime. The CLI installs via npm and re-executes itself under bun automatically.

## Install

```bash
curl -fsSL https://bun.sh/install | bash   # once, if you don't have bun
npm install -g openomni                     # or: bun add -g openomni
```

## Set up and run 24/7

```bash
openomni onboard          # interactive: model provider/id/API key, port, channel tokens
openomni daemon install   # launchd (macOS) / systemd --user (Linux); starts now, survives reboot
openomni doctor           # read-only diagnostics
openomni logs             # follow the daemon logs
```

Configuration lives in `~/.openomni/env` (written by `onboard`, chmod 0600). Data lives in `~/.openomni/`. Exported `OPENOMNI_*` environment variables always override the file.

On Linux, keep the user service alive after logout:

```bash
loginctl enable-linger $USER
```

## Foreground run

```bash
openomni start
```

The Resident listens on `ws://127.0.0.1:3000/ws` by default (WebSocket, token-gated off loopback) with a `GET /health` endpoint on the same port.

## Commands

| Command | What it does |
| --- | --- |
| `openomni start` | Run the Resident in the foreground |
| `openomni onboard` | Interactive setup, writes `~/.openomni/env` |
| `openomni daemon install\|uninstall\|status\|start\|stop\|restart` | Manage the 24/7 service |
| `openomni doctor` | Diagnostics: config, daemon state, health probe |
| `openomni logs` | Follow daemon logs |

Source, docs, and issues: <https://github.com/INONONO66/openomni>
