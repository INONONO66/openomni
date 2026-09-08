import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { parseLocus } from "./locus";
import { fileOperation, type FilePorts } from "./core/filesystem";

const Input = z
  .object({
    command: z.string().min(1),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Seconds before the local command is killed. Remote commands are bounded by the daemon."),
    machine: z.string().min(1).optional(),
  })
  .strict();

const Output = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});

async function remoteBash(args: z.output<typeof Input>, ports: FilePorts) {
  const machine = args.machine ?? "";
  const locus = parseLocus(`${machine}:/`);
  if (locus.kind !== "machine" || locus.machine !== machine || locus.path !== "/")
    throw new ToolRefused("bash", "invalid machine id");
  if (args.timeout !== undefined)
    throw new ToolRefused("bash", "timeout applies to local commands; the daemon bounds remote ones");
  const target = ports.machines?.get(locus.machine);
  if (target === undefined) throw new ToolRefused("bash", "machine host is not configured");
  const result = await target.exec(args.command, "/");
  if (result.status !== "completed")
    throw new ToolRefused("bash", result.status === "refused" ? result.reason : result.status);
  return {
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
    exitCode: result.exitCode,
    signal: result.signal,
    truncated: result.truncated,
    timedOut: false,
  };
}

async function localBash(args: z.output<typeof Input>, signal: AbortSignal) {
  const deadline = args.timeout === undefined ? undefined : AbortSignal.timeout(args.timeout * 1000);
  const child = Bun.spawn(["/bin/bash", "-c", args.command], {
    stdout: "pipe",
    stderr: "pipe",
    signal: deadline === undefined ? signal : AbortSignal.any([signal, deadline]),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal.throwIfAborted();
  return {
    stdout,
    stderr,
    exitCode,
    signal: child.signalCode ?? null,
    truncated: false,
    timedOut: deadline?.aborted ?? false,
  };
}

export function createBashTool(ports: FilePorts) {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command locally, or on the named machine. Local cwd is the host process cwd; remote cwd is /. Use cd in command to change directory. Remote / must be an offered export. No persistent cwd state.",
    category: "execution",
    sequential: true,
    input: Input,
    output: Output,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("bash", () => {
        ctx.signal.throwIfAborted();
        return args.machine === undefined ? localBash(args, ctx.signal) : remoteBash(args, ports);
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
