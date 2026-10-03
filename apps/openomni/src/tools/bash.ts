import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
import { z } from "zod";
import { parseLocus } from "./locus";
import { defaultMachineOf, fileOperation, type FilePorts } from "./core/filesystem";

const Input = z
  .object({
    command: z.string().min(1),
    machine: z.string().min(1).optional(),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute working directory inside an offered export; defaults to /."),
  })
  .strict();

const Output = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean(),
});

/**
 * Every command runs on a machine daemon (#1271): the named machine, or the
 * configured default when `machine` is omitted. There is no process-local
 * execution path; the daemon bounds execution time and confines cwd to its
 * offered exports.
 */
async function machineBash(args: z.output<typeof Input>, ports: FilePorts) {
  const machine = args.machine ?? defaultMachineOf(ports);
  const cwd = args.cwd ?? "/";
  const locus = parseLocus(`${machine}:${cwd}`, { defaultMachine: machine });
  if (locus.machine !== machine || locus.path !== cwd)
    throw new ToolRefused("bash", "expected a plain machine id and an absolute cwd");
  const target = ports.machines?.get(locus.machine);
  if (target === undefined) throw new ToolRefused("bash", "machine host is not configured");
  const result = await target.exec(args.command, locus.path);
  if (result.status !== "completed")
    throw new ToolRefused("bash", result.status === "refused" ? result.reason : result.status);
  return {
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
    exitCode: result.exitCode,
    signal: result.signal,
    truncated: result.truncated,
  };
}

export function createBashTool(ports: FilePorts) {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command on a machine daemon: the named machine, or the configured default when machine is omitted. cwd must be an absolute path inside an offered export (default /). Execution time is bounded by the daemon. No persistent cwd state.",
    category: "execution",
    sequential: true,
    input: Input,
    output: Output,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("bash", () => {
        ctx.signal.throwIfAborted();
        return machineBash(args, ports);
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
