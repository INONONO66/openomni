import { defineTool, ToolRefused } from "@openomni/agent";
import { z } from "zod";
import { parseLocus } from "../locus";
import { fileOperation, type FilePorts } from "../fs/endpoint";

export function createBashTool(ports: FilePorts) {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command locally, or on the named machine. Local cwd is the host process cwd; remote cwd is /. Use cd in cmd to change directory. Remote / must be an offered export. No persistent cwd state.",
    category: "execution",
    sequential: true,
    input: z.object({ cmd: z.string().min(1), machine: z.string().min(1).optional() }).strict(),
    output: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      truncated: z.boolean(),
    }),
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: (args, ctx) =>
      fileOperation("bash", async () => {
        ctx.signal.throwIfAborted();
        if (args.machine !== undefined) {
          const locus = parseLocus(`${args.machine}:/`);
          if (locus.kind !== "machine") throw new ToolRefused("bash", "invalid machine id");
          const target = ports.machines?.get(locus.machine);
          if (target === undefined) throw new ToolRefused("bash", "machine host is not configured");
          const result = await target.exec(args.cmd, locus.path);
          if (result.status !== "completed")
            throw new ToolRefused(
              "bash",
              result.status === "refused" ? result.reason : result.status,
            );
          return {
            stdout: Buffer.from(result.stdout).toString("utf8"),
            stderr: Buffer.from(result.stderr).toString("utf8"),
            exitCode: result.exitCode,
            signal: result.signal,
            truncated: result.truncated,
          };
        }
        const child = Bun.spawn(["/bin/bash", "-c", args.cmd], {
          stdout: "pipe",
          stderr: "pipe",
          signal: ctx.signal,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exitCode, signal: child.signalCode ?? null, truncated: false };
      }),
    render: (_args, value) => JSON.stringify(value),
  });
}
