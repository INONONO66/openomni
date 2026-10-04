import { armCron, armWatch, type MonitorPorts, WatchState } from "./core/watch";
import { isAbsolute } from "node:path";
import { Core } from "@openomni/agent";
const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;
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
        kind: z.literal("terminal"),
        machine: z.string().min(1),
        session: z.string().min(1),
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
    z
      .object({
        kind: z.literal("cron"),
        expr: z.string().min(1),
        /** IANA zone the grid is computed in (DST-correct re-arms). */
        tz: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((spec, context) => {
    if (spec.kind === "cron") return;
    if ((spec.persistent === true) === (spec.timeout_ms !== undefined))
      context.addIssue({
        code: "custom",
        message: "exactly one of persistent and timeout_ms is required",
      });
    if (spec.kind === "path" && !isAbsolute(spec.path))
      context.addIssue({ code: "custom", path: ["path"], message: "path must be absolute" });
    if (spec.kind !== "path" && spec.filter !== undefined) {
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
      "Watch command output in a PTY, a machine terminal session, an absolute path, or a cron schedule outside the session. Create a persistent or timed watch or a recurring cron chain, rearm a retired one, or cancel it.",
    input,
    output: WatchState,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    sequential: true,
    async execute(request, context) {
      const args = request.operation;
      if (ports === undefined) throw new ToolRefused("monitor", "alarm port unavailable");
      context.signal.throwIfAborted();
      if (args.op !== "create") {
        return ports[args.op](args.id, context.sessionId, ports.clock(), context.signal);
      }
      if (args.source.kind === "cron") {
        const { kind, ...fields } = args.source;
        return armCron(ports, fields, args.description, context);
      }
      const { kind, ...fields } = args.source;
      return armWatch(ports, fields, args.description, context);
    },
    render: (_args, row) => JSON.stringify({ id: row.id, kind: row.kind, status: row.status }),
  });
}
