import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OnboardIO } from "./onboard";

type UnitScope = "system" | "user";

export interface UnitContext {
  /** Absolute path to the bun binary running this process. */
  execPath: string;
  /** Absolute path to the openomni CLI entry script. */
  scriptPath: string;
  scope: UnitScope;
}

// systemd expands `%` specifiers and `$` variables inside ExecStart and
// Environment even within quotes; literal occurrences in install paths must
// be doubled or the unit resolves to a different path than was installed.
function systemdEscape(value: string): string {
  return value.replace(/%/g, "%%").replace(/\$/g, "$$$$");
}

/**
 * The unit pins PATH because the coordinator spawns workers via a bare `bun`
 * lookup, and the default systemd PATH does not include ~/.bun/bin. Paths are
 * quoted — install locations with spaces would otherwise split ExecStart.
 */
export function renderSystemdUnit(ctx: UnitContext): string {
  const binDir = systemdEscape(dirname(ctx.execPath));
  return `[Unit]
Description=OpenOmni server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${systemdEscape(ctx.execPath)}" "${systemdEscape(ctx.scriptPath)}" serve
Restart=on-failure
RestartSec=2
Environment="PATH=${binDir}:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=${ctx.scope === "system" ? "multi-user.target" : "default.target"}
`;
}

/**
 * Installs and enables the unit where possible; everywhere else it prints the
 * unit text and manual steps. Never fails onboarding (handoff: non-fatal).
 */
export function installDaemon(io: Pick<OnboardIO, "log" | "warn">): void {
  const execPath = process.execPath;
  // Onboarding always runs through the CLI entry, so argv[1] is the exact
  // script the daemon must re-run (source cli.ts in dev, dist bundle when
  // installed globally).
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    io.warn("cannot determine the CLI entry path; skipping daemon install");
    return;
  }

  if (process.platform !== "linux") {
    io.log("");
    io.log("systemd is unavailable on this platform; on your Linux host save this unit:");
    io.log(renderSystemdUnit({ execPath, scriptPath, scope: "system" }));
    return;
  }

  const isRoot = process.getuid?.() === 0;
  if (isRoot) {
    // The system-scope unit carries no User= — state lives in the onboarding
    // user's ~/.openomni, and onboard-as-root wrote /root/.openomni, so
    // pointing User= elsewhere would orphan the config. Surface the posture
    // instead of silently installing a root service.
    io.warn(
      "installing a system-scope unit that runs the server as root; prefer onboarding as a dedicated non-root user (systemd --user + loginctl enable-linger)",
    );
  }
  const scope: UnitScope = isRoot ? "system" : "user";
  const unitDir = isRoot ? "/etc/systemd/system" : join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "openomni.service");
  const unit = renderSystemdUnit({ execPath, scriptPath, scope });
  const systemctl = isRoot ? ["systemctl"] : ["systemctl", "--user"];

  try {
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, unit);
    io.log(`wrote ${unitPath}`);
    runOrThrow([...systemctl, "daemon-reload"]);
    runOrThrow([...systemctl, "enable", "--now", "openomni"]);
    io.log(`enabled openomni.service (${scope} scope)`);
    if (!isRoot) {
      io.log("to keep it running after logout: loginctl enable-linger $USER");
    }
  } catch (error) {
    io.warn(
      `could not enable the systemd unit (${error instanceof Error ? error.message : String(error)})`,
    );
    io.log("install it manually:");
    io.log(unit);
    io.log(`  ${systemctl.join(" ")} daemon-reload`);
    io.log(`  ${systemctl.join(" ")} enable --now openomni`);
  }
}

function runOrThrow(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited with ${result.exitCode}`);
  }
}
