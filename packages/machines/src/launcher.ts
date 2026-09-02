import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type { ChildProcessWithoutNullStreams };

export interface SandboxProfile {
  readonly backend: "bubblewrap";
  readonly bwrapPath: string;
  readonly pythonPath: string;
  readonly workspaceRoot: string;
  readonly readOnlyPaths: readonly string[];
  readonly maxOutputBytes: number;
}

export type SandboxProbe =
  | { readonly ok: true; readonly profileDigest: string }
  | {
      readonly ok: false;
      readonly reason:
        | "backend_missing"
        | "userns_unavailable"
        | "python_missing"
        | "workspace_unwritable"
        | "probe_failed";
      readonly detail: string;
    };

export type Launcher = (tenant: string) => ChildProcessWithoutNullStreams;

type ProbeProcessResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const PROBE_SOURCE = `
import json
import pathlib
import socket

pathlib.Path("/workspace/probe-write").write_text("ok")
outside_denied = False
try:
    pathlib.Path("/usr/openomni-sandbox-probe").write_text("escaped")
except OSError:
    outside_denied = True
network_denied = False
try:
    socket.create_connection(("127.0.0.1", 9), 1)
except OSError:
    network_denied = True
print(json.dumps({"outsideDenied": outside_denied, "networkDenied": network_denied}))
raise SystemExit(0 if outside_denied and network_denied else 1)
`;

function tenantDigest(tenant: string): string {
  return createHash("sha256").update(tenant).digest("hex");
}

function profileDigest(profile: SandboxProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backend: profile.backend,
        bwrapPath: profile.bwrapPath,
        pythonPath: profile.pythonPath,
        workspaceRoot: profile.workspaceRoot,
        readOnlyPaths: profile.readOnlyPaths,
        maxOutputBytes: profile.maxOutputBytes,
      }),
    )
    .digest("hex");
}

function sandboxArgv(
  profile: SandboxProfile,
  workspace: string,
  driverSource: string,
): readonly string[] {
  const readOnlyBinds = profile.readOnlyPaths.flatMap((path) => ["--ro-bind", path, path]);
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/workspace",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
    ...readOnlyBinds,
    "--bind",
    workspace,
    "/workspace",
    "--chdir",
    "/workspace",
    "--",
    profile.pythonPath,
    "-u",
    "-c",
    driverSource,
  ];
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executable(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function runProbeProcess(profile: SandboxProfile, workspace: string): Promise<ProbeProcessResult> {
  return new Promise((resolve, reject) => {
    const process = spawn(profile.bwrapPath, sandboxArgv(profile, workspace, PROBE_SOURCE));
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < profile.maxOutputBytes) {
        stdout += chunk.toString("utf8", 0, profile.maxOutputBytes - stdout.length);
      }
    });
    process.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < profile.maxOutputBytes) {
        stderr += chunk.toString("utf8", 0, profile.maxOutputBytes - stderr.length);
      }
    });
    process.once("error", reject);
    process.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function probeSandbox(profile: SandboxProfile): Promise<SandboxProbe> {
  if (!(await executable(profile.bwrapPath))) {
    return { ok: false, reason: "backend_missing", detail: "bubblewrap executable unavailable" };
  }
  if (!(await executable(profile.pythonPath))) {
    return { ok: false, reason: "python_missing", detail: "Python executable unavailable" };
  }
  if (!isAbsolute(profile.workspaceRoot)) {
    return {
      ok: false,
      reason: "workspace_unwritable",
      detail: "workspace root must be absolute",
    };
  }

  const probeWorkspace = join(profile.workspaceRoot, tenantDigest(`probe:${randomUUID()}`));
  try {
    await mkdir(probeWorkspace, { recursive: true, mode: 0o700 });
    await access(probeWorkspace, constants.W_OK);
  } catch (error) {
    return { ok: false, reason: "workspace_unwritable", detail: detailOf(error) };
  }

  try {
    const result = await runProbeProcess(profile, probeWorkspace);
    if (result.code === 0) {
      return { ok: true, profileDigest: profileDigest(profile) };
    }
    const detail =
      result.stderr.trim() || result.stdout.trim() || `signal=${String(result.signal)}`;
    if (/namespace|operation not permitted|permission denied/i.test(detail)) {
      return { ok: false, reason: "userns_unavailable", detail };
    }
    return { ok: false, reason: "probe_failed", detail };
  } catch (error) {
    return { ok: false, reason: "probe_failed", detail: detailOf(error) };
  } finally {
    await rm(probeWorkspace, { recursive: true, force: true });
  }
}

export function sandboxedLauncher(profile: SandboxProfile, driverSource: string): Launcher {
  return (tenant) => {
    const workspace = join(profile.workspaceRoot, tenantDigest(tenant));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return spawn(profile.bwrapPath, sandboxArgv(profile, workspace, driverSource));
  };
}
