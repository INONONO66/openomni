import { armWatch, type MonitorPorts } from "./core/monitor-ports";
import { isAbsolute } from "node:path";
import { defineTool, ToolRefused } from "@openomni/agent";
import { Alarm } from "@openomni/protocol";
import { z } from "zod";

const lifetime = {
  persistent: z.literal(true).optional(),
  timeout_ms: z.number().int().positive().optional(),
};
const source = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("command"),
        command: z.string().min(1),
        filter: z.string().optional(),
        ...lifetime,
      })
      .strict(),
    z
      .object({
        kind: z.literal("path"),
        path: z.string().min(1),
        event: z.enum(["create", "modify"]),
        ...lifetime,
      })
      .strict(),
  ])
  .superRefine((spec, context) => {
    if ((spec.persistent === true) === (spec.timeout_ms !== undefined))
      context.addIssue({
        code: "custom",
        message: "exactly one of persistent and timeout_ms is required",
      });
    if (spec.kind === "path" && !isAbsolute(spec.path))
      context.addIssue({ code: "custom", path: ["path"], message: "path must be absolute" });
    if (spec.kind === "command" && spec.filter !== undefined) {
      try {
        new RegExp(spec.filter);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["filter"],
          message: "invalid regular expression",
        });
      }
    }
  });
const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), description: z.string().min(1), source }).strict(),
  z.object({ op: z.literal("rearm"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("cancel"), id: z.string().min(1) }).strict(),
]);
// Like provision: an object root preserves the framework's model ABI.
const input = z.object({ operation }).strict();

export function createMonitorTool(ports?: MonitorPorts) {
  return defineTool({
    name: "monitor",
    category: "mutation",
    description:
      "Watch command output in a PTY or an absolute path outside the session. Create a persistent or timed watch, rearm a paused watch, or cancel it.",
    input,
    output: Alarm.Row,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    sequential: true,
    async execute(request, context) {
      const args = request.operation;
      if (ports === undefined) throw new ToolRefused("monitor", "alarm port unavailable");
      context.signal.throwIfAborted();
      const at = ports.clock();
      if (args.op !== "create") {
        return ports[args.op](args.id, context.sessionId, at, context.signal);
      }
      const { kind, ...fields } = args.source;
      return armWatch(ports, fields, args.description, context, at);
    },
    render: (_args, row) => JSON.stringify({ id: row.id, status: row.status, epoch: row.epoch }),
  });
}
