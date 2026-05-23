# Deploy

Deployment lifecycle for OpenOmni. Covers install, configuration, updates, and removal.

---

## Prerequisites

- **Bun** runtime — https://bun.sh
- **Linux with systemd** (primary target). The scripts use `systemctl --user` and assume a user-level service.
- **macOS** — launchd skeleton exists under `deploy/launchd/` but is not functional yet.
- **Systemd linger** — required so the service survives after you log out:

  ```bash
  loginctl enable-linger <username>
  ```

---

## Quick Install

```bash
./deploy/install.sh
```

This script is idempotent — safe to re-run. It:

1. Copies the systemd unit file to `~/.config/systemd/user/openomni.service`
2. Creates `~/.openomni/` and populates default config/env if they don't exist
3. Runs `systemctl --user daemon-reload && systemctl --user enable --now openomni`
4. Calls the health check to confirm the daemon is up

---

## Configuration

Two files live in `~/.openomni/`:

| File | Purpose | Template |
|------|---------|----------|
| `config.json` | Runtime config (port, DB path, log level) | `deploy/templates/config.json` |
| `.env` | Secrets and API keys | `deploy/templates/env.example` |

`install.sh` copies the templates on first run. **Existing files are never overwritten on re-install**, so your secrets stay intact.

To reset to defaults manually:

```bash
cp deploy/templates/config.json ~/.openomni/config.json
cp deploy/templates/env.example ~/.openomni/.env
```

The server binds to `127.0.0.1:3000` by default. Change `port` in `config.json` to override.

---

## Managing the Daemon

```bash
# Status
systemctl --user status openomni

# Start / stop / restart
systemctl --user start openomni
systemctl --user stop openomni
systemctl --user restart openomni

# Follow logs
journalctl --user -u openomni -f
```

Health endpoint (quick sanity check):

```bash
curl http://127.0.0.1:3000/health
# → { "ok": true, "timestamp": "..." }
```

---

## Updating

```bash
./deploy/update.sh
```

This does: `git pull` + `bun install` + `systemctl --user restart openomni`. The health check runs at the end to confirm the new version is serving.

---

## Uninstalling

Remove the service only (keeps your data):

```bash
./deploy/uninstall.sh
```

Remove the service **and** all data under `~/.openomni/` (config, DB, logs):

```bash
./deploy/uninstall.sh --purge
```

`--purge` is irreversible. Back up `~/.openomni/storage.db` first if you want to keep history.

---

## Troubleshooting

```bash
./deploy/doctor.sh
```

Read-only diagnostics. Never auto-fixes anything. Outputs `PASS`, `FAIL`, or `WARN` for each check:

- Bun version
- Systemd linger status
- Service unit file presence
- Service running state
- Health endpoint reachability
- Config and `.env` file presence
- DB file presence

Run this first when something looks wrong. Share the output when filing a bug.

---

## Release

> Maintainers only.

```bash
./deploy/release.sh v0.1.0
```

Creates a git tag `v0.1.0` locally and prints the push instructions. It does **not** push automatically — review the tag first, then:

```bash
git push origin v0.1.0
```

---

## QA Verification

After install or update, run the post-install health suite:

```bash
./qa/server-daemon/health-check.sh
```

This hits the health endpoint, checks response shape, and verifies the service is enabled for auto-start. Use it in CI or after any production deploy to confirm the daemon is healthy.
