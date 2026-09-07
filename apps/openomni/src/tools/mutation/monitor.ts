import { isAbsolute } from "node:path";
import { defineTool, ToolRefused } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { Alarm, LedgerAction } from "@openomni/protocol";
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
  z.object({ op: z.literal("rearm"), alarmId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("cancel"), alarmId: z.string().min(1) }).strict(),
]);
// Like approval/provision: an object root preserves the framework's model ABI.
const input = z.object({ operation }).strict();

export const monitorTool = defineTool({
  name: "monitor",
  category: "mutation",
  description:
    "Watch command output in a PTY or an absolute path outside the session. Create a persistent or timed watch, rearm a paused watch, or cancel it.",
  input,
  output: Alarm.Row,
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  sequential: true,
  async execute({ operation: args }, context) {
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new ToolRefused("monitor", "alarm storage unavailable");
    context.signal.throwIfAborted();
    const at = Date.now();
    if (args.op !== "create") {
      const current = alarms.get(args.alarmId);
      if (current === undefined || current.sessionId !== context.sessionId)
        throw new ToolRefused("monitor", "alarm not found in this session");
      const row =
        args.op === "cancel" ? alarms.cancel(current.id, at) : alarms.rearm(current.id, at);
      if (row === undefined) throw new ToolRefused("monitor", "alarm control refused");
      return row;
    }
    const { kind: _kind, ...fields } = args.source;
    const watch = Alarm.Watch.parse({ ...fields, description: args.description });
    const actions = SessionHandleStore.tree(context.sessionId);
    const turn = SessionHandleStore.turnIntent(
      actions.find((action) => action.id === context.turnId),
    );
    if (turn === undefined) throw new ToolRefused("monitor", "no captured turn");
    const policy = compilePolicySnapshot({
      generation: turn.policyGeneration,
      rows: SessionHandleStore.policyRows(turn.policyGeneration),
      kinds: LedgerAction.Kind.options,
    });
    const evaluation = policy.evaluate({
      kind: "tool",
      phase: "pre",
      op: "monitor",
      role: SessionHandleStore.row(context.sessionId).role,
      sessionId: context.sessionId,
      value: watch,
    });
    const limits = evaluation.obligations.filter(
      (obligation) => obligation.metric === "notifications",
    );
    if (evaluation.verdict === "deny" || evaluation.error !== undefined || limits.length === 0)
      throw new ToolRefused("monitor", "captured wake budget unavailable");
    const row = alarms.arm({
      id: crypto.randomUUID(),
      sessionId: context.sessionId,
      kind: "watch",
      fireAt: at,
      spec: {
        encodingVersion: 1,
        value: {
          watch,
          policyGeneration: turn.policyGeneration,
          notificationLimit: Math.min(...limits.map((limit) => limit.limit)),
        },
      },
    });
    if (row === undefined) throw new ToolRefused("monitor", "alarm arm refused");
    return row;
  },
  render: (_args, row) => JSON.stringify({ id: row.id, status: row.status, epoch: row.epoch }),
});
