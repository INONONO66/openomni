# QA: Server Daemon

Post-install verification scripts for the OpenOmni server daemon. These scripts check the product surface after a real deploy. They do not start a server, run unit tests, or touch source code.

## What this is

`qa/server-daemon/` verifies that a deployed OpenOmni instance is working correctly. It tests the running system from the outside: service registration, health endpoint, config presence, and clean removal.

This is not a test suite. It's a runbook for operators.

## When to run

- After `./deploy/install.sh`
- After `./deploy/update.sh`
- In CI after a production deploy
- Before marking a release as stable

## Prerequisites

OpenOmni must already be installed and running before you use any of these scripts.

```bash
./deploy/install.sh
```

If the daemon isn't running, all checks will fail. That's expected behavior, not a bug in the scripts.

---

## Scripts

### `health-check.sh`

Checks whether the server daemon is responding on its health endpoint.

```bash
./qa/server-daemon/health-check.sh
./qa/server-daemon/health-check.sh --port 3000
```

**Expected output:**

```text
PASS: OpenOmni is healthy on port 3000
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | Daemon is healthy and responding |
| 1 | Daemon is not responding |

---

### `install-smoke.sh`

Verifies that all expected artifacts of a successful install are present and the service is active.

```bash
./qa/server-daemon/install-smoke.sh
```

**Checks performed:**

1. Service unit is registered
2. Service is active
3. Health endpoint responds OK
4. Config file exists
5. App directory exists

**Expected output:**

```text
5/5 checks passed
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | One or more checks failed |

---

### `uninstall-smoke.sh`

Verifies clean removal after `./deploy/uninstall.sh`. Checks pass when artifacts are *gone*, not present.

```bash
./qa/server-daemon/uninstall-smoke.sh
```

**Checks performed:**

1. Service unit is gone
2. Service is not active
3. Health endpoint is not responding

**Expected output:**

```text
3/3 checks passed
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | Uninstall was clean |
| 1 | Artifacts remain |

---

## Troubleshooting

If any checks fail, run the diagnostic tool:

```bash
./deploy/doctor.sh
```

`doctor.sh` inspects the system state and reports what's wrong. Fix the issues it surfaces, then re-run the relevant QA script.
