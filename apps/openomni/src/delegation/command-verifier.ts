import type { Machine } from "@openomni/protocol";
import { z } from "zod";
import type { CellPorts } from "../tools/run-code";
import type { CommandRunResult, CommandVerifierPort } from "./verification";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const CellCommandResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("exited"),
      exitCode: z.number().int(),
      stdoutSha256: Sha256,
      stderrSha256: Sha256,
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("timed_out"), durationMs: z.number().nonnegative() }).strict(),
  z
    .object({
      status: z.literal("killed"),
      signal: z.string().min(1),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
]);

class CommandVerifierError extends Error {
  readonly name = "CommandVerifierError";

  constructor(
    readonly reason: "cell_raised" | "malformed_result",
    cause?: Error,
  ) {
    super(`command verifier ${reason}`, cause === undefined ? undefined : { cause });
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unreachable command verifier outcome: ${JSON.stringify(value)}`);
}

export function createCommandVerifier(ports: {
  readonly runCell: CellPorts["runCell"];
  readonly machineFor: (tenant: string) => Machine.MachineId | undefined;
  readonly executables: ReadonlyMap<string, string>;
  readonly newCellId: () => string;
  readonly maxOutputBytes: number;
}): CommandVerifierPort {
  return {
    async run(input): Promise<CommandRunResult> {
      const executable = ports.executables.get(input.executableId);
      if (executable === undefined) {
        return { status: "refused", reason: "executable_unregistered" };
      }
      const machineId = ports.machineFor(input.tenant);
      if (machineId === undefined) {
        return { status: "refused", reason: "machine_not_attached" };
      }

      // JSON inside a Python string literal is the only path from the declared
      // argv into code. The generated cell always passes one absolute path +
      // literal argv to subprocess with shell=False, an empty env, and the
      // tenant sandbox's fixed /workspace cwd.
      const commandJson = JSON.stringify([executable, ...input.argv]);
      const commandLiteral = JSON.stringify(commandJson);
      const timeoutSeconds = input.timeoutMs / 1000;
      const code = `
import hashlib
import json
import signal
import subprocess
import threading
import time

class _StreamCapture:
    def __init__(self):
        self.retained = bytearray()
        self.digest = hashlib.sha256()
        self.count = 0

    def drain(self, pipe):
        while True:
            chunk = pipe.read(65536)
            if not chunk:
                return
            self.digest.update(chunk)
            self.count += len(chunk)
            remaining = ${ports.maxOutputBytes} - len(self.retained)
            if remaining > 0:
                self.retained.extend(chunk[:remaining])

_started = time.monotonic()
_process = subprocess.Popen(
    json.loads(${commandLiteral}),
    shell=False,
    cwd="/workspace",
    env={},
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
_stdout = _StreamCapture()
_stderr = _StreamCapture()
_stdout_thread = threading.Thread(target=_stdout.drain, args=(_process.stdout,))
_stderr_thread = threading.Thread(target=_stderr.drain, args=(_process.stderr,))
_stdout_thread.start()
_stderr_thread.start()
try:
    _returncode = _process.wait(timeout=${timeoutSeconds})
except subprocess.TimeoutExpired:
    _process.kill()
    _process.wait()
    _stdout_thread.join()
    _stderr_thread.join()
    print(json.dumps({
        "status": "timed_out",
        "durationMs": (time.monotonic() - _started) * 1000,
    }, separators=(",", ":")))
else:
    _stdout_thread.join()
    _stderr_thread.join()
    _duration_ms = (time.monotonic() - _started) * 1000
    if _returncode < 0:
        _result = {
            "status": "killed",
            "signal": signal.Signals(-_returncode).name,
            "durationMs": _duration_ms,
        }
    else:
        _result = {
            "status": "exited",
            "exitCode": _returncode,
            "stdoutSha256": _stdout.digest.hexdigest(),
            "stderrSha256": _stderr.digest.hexdigest(),
            "stdoutBytes": _stdout.count,
            "stderrBytes": _stderr.count,
            "truncated": _stdout.count > len(_stdout.retained) or _stderr.count > len(_stderr.retained),
            "durationMs": _duration_ms,
        }
    print(json.dumps(_result, separators=(",", ":")))
`;
      const result = await ports.runCell(machineId, {
        cellId: ports.newCellId(),
        code,
        timeoutMs: input.timeoutMs + 1000,
        tenant: input.tenant,
      });
      switch (result.status) {
        case "completed": {
          let json: unknown;
          try {
            json = JSON.parse(result.output.stdout.trim());
          } catch (error) {
            throw new CommandVerifierError(
              "malformed_result",
              error instanceof Error ? error : undefined,
            );
          }
          const parsed = CellCommandResult.safeParse(json);
          if (!parsed.success) throw new CommandVerifierError("malformed_result", parsed.error);
          return parsed.data;
        }
        case "raised":
          throw new CommandVerifierError("cell_raised");
        case "timed_out":
          return { status: "timed_out", durationMs: input.timeoutMs };
        case "refused":
          switch (result.reason) {
            case "machine_not_attached":
              return { status: "refused", reason: "machine_not_attached" };
            case "kernel_not_available":
            case "isolation_unavailable":
              return { status: "refused", reason: "isolation_unavailable" };
            default:
              return assertNever(result.reason);
          }
        default:
          return assertNever(result);
      }
    },
  };
}
