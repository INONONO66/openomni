/**
 * Read-only diagnostics. Every fact arrives through `DoctorPorts` so the
 * verdict mapping is deterministic and testable; the CLI wires real probes.
 */
export interface DoctorPorts {
  readonly bunVersion: string;
  readonly envFilePresent: boolean;
  /** Effective config: env file merged under process-env overrides. */
  readonly effectiveEnv: ReadonlyMap<string, string>;
  readonly unitInstalled: boolean;
  readonly daemonActive: boolean;
  /** Linger state on systemd hosts; undefined = not applicable (launchd). */
  readonly lingerEnabled: boolean | undefined;
  readonly probeHealth: (port: number) => Promise<boolean>;
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const REQUIRED_KEYS = [
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
] as const;

export async function runDoctor(ports: DoctorPorts): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [{ name: "bun", status: "pass", detail: ports.bunVersion }];

  checks.push(
    ports.envFilePresent
      ? { name: "env file", status: "pass", detail: "present" }
      : {
          name: "env file",
          status: "warn",
          detail: "missing — exported environment only (run `openomni onboard` to create one)",
        },
  );
  // A blank value fails startup exactly like a missing one.
  const missing = REQUIRED_KEYS.filter(
    (key) => (ports.effectiveEnv.get(key) ?? "").trim().length === 0,
  );
  checks.push(
    missing.length === 0
      ? { name: "model config", status: "pass", detail: "provider, id, and API key set" }
      : { name: "model config", status: "fail", detail: `missing ${missing.join(", ")}` },
  );

  if (ports.unitInstalled) {
    checks.push(
      ports.daemonActive
        ? { name: "daemon", status: "pass", detail: "active" }
        : { name: "daemon", status: "fail", detail: "installed but not active" },
    );
    if (ports.lingerEnabled === false) {
      checks.push({
        name: "linger",
        status: "warn",
        detail: "disabled — daemon dies at logout; run `loginctl enable-linger`",
      });
    }
  } else {
    checks.push({
      name: "daemon",
      status: "warn",
      detail: "not installed — run `openomni daemon install`",
    });
  }

  const rawPort = ports.effectiveEnv.get("OPENOMNI_WS_PORT");
  const port =
    rawPort !== undefined && /^\d+$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65_535
      ? Number(rawPort)
      : 3000;
  const healthy = await ports.probeHealth(port);
  if (healthy) {
    checks.push({ name: "health", status: "pass", detail: `http://127.0.0.1:${port}/health ok` });
  } else {
    checks.push({
      name: "health",
      status: ports.daemonActive ? "fail" : "warn",
      detail: `no response on http://127.0.0.1:${port}/health`,
    });
  }

  return { checks, ok: checks.every((check) => check.status !== "fail") };
}
