import { isAbsolute } from "node:path";
import { defineTool, ToolRefused } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { Alarm, LedgerAction } from "@openomni/protocol";
import { z } from "zod";

export const watchSpec = z
  .object({
    watch: Alarm.Watch,
    policyGeneration: z.number().int().positive(),
    notificationLimit: z.number().int().positive(),
  })
  .strict();

const input = z
  .object({
    op: z.enum(["create", "rearm", "cancel"]),
    id: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    filter: z.string().optional(),
    path: z.string().min(1).optional(),
    event: z.enum(["create", "modify"]).optional(),
    description: z.string().min(1).optional(),
    persistent: z.literal(true).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((args, context) => {
    const { op, id, ...spec } = args;
    if (op !== "create") {
      if (id === undefined || Object.values(spec).some((value) => value !== undefined))
        context.addIssue({ code: "custom", message: "control requires only op and id" });
      return;
    }
    const parsed = Alarm.Watch.safeParse(spec);
    if (id !== undefined || !parsed.success) {
      context.addIssue({
        code: "custom",
        message: "create requires one command or path watch and a lifetime",
      });
      return;
    }
    if ("path" in parsed.data && !isAbsolute(parsed.data.path))
      context.addIssue({ code: "custom", path: ["path"], message: "path must be absolute" });
    if ("filter" in parsed.data && parsed.data.filter !== undefined) {
      try {
        new RegExp(parsed.data.filter);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["filter"],
          message: "invalid regular expression",
        });
      }
    }
  });

export const monitorTool = defineTool({
  name: "monitor",
  category: "mutation",
  description:
    "Watch command output in a PTY or an absolute path outside the session. Create a persistent or timed watch, rearm a paused watch, or cancel it.",
  input,
  output: Alarm.Row,
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  sequential: true,
  async execute(args, context) {
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new ToolRefused("monitor", "alarm storage unavailable");
    context.signal.throwIfAborted();
    const at = Date.now();
    if (args.op !== "create") {
      const current = args.id === undefined ? undefined : alarms.get(args.id);
      if (current === undefined || current.sessionId !== context.sessionId)
        throw new ToolRefused("monitor", "alarm not found in this session");
      const row =
        args.op === "cancel" ? alarms.cancel(current.id, at) : alarms.rearm(current.id, at);
      if (row === undefined) throw new ToolRefused("monitor", "alarm control refused");
      return row;
    }
    const { op: _op, id: _id, ...spec } = args;
    const watch = Alarm.Watch.parse(spec);
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
      value: spec,
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
