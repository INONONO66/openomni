import { Bundle, Core } from "@openomni/agent";
import { Alarm, type PolicyRow } from "@openomni/protocol";
import { z } from "zod";
import { ToolCapabilitySeam } from "../seams";
import { armCron, armWatch, type MonitorPorts, WatchState } from "../../tools/core/watch";

const defineTool = Core.defineTool;
const ToolRefused = Core.ToolRefused;

/**
 * The `monitor` bundle (#1255): the sealed `monitor` tool face, the wake
 * budget policy row, and the watch plane's purposes (`monitor.hit`,
 * `monitor.timeout`) declared over the alarm capability. It replaces
 * `tools/monitor.ts` and `composition/bundles/monitor.ts`; the purpose
 * handlers live in `plugins/alarm` (`Bundle.watchPurposes`).
 */

const lifetime = {
  persistent: z.literal(true).optional(),
  timeout_ms: z.number().int().positive().optional(),
};
const source = z.discriminatedUnion("kind", [
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
]);
const operation = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("create"), description: z.string().min(1), source })
    .strict()
    // #1255: watch cross-field validation IS the protocol's `Alarm.Watch` —
    // one schema, never a competing duplicate (body census tools/monitor.ts:6).
    .superRefine((create, context) => {
      if (create.source.kind === "cron") return;
      const { kind: _kind, ...fields } = create.source;
      const watch = Alarm.Watch.safeParse({ ...fields, description: create.description });
      if (watch.success) return;
      for (const issue of watch.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["source", ...issue.path],
          message: issue.message,
        });
      }
    }),
  z.object({ op: z.literal("rearm"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("cancel"), id: z.string().min(1) }).strict(),
]);
// Like provision: an object root preserves the framework's model ABI.
const input = z.object({ operation }).strict();

export function createMonitorTool(ports: MonitorPorts | undefined) {
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
        return ports[args.op](
          args.id,
          context.sessionId,
          context.turnId,
          ports.clock(),
          context.signal,
        );
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

/**
 * The monitor wake budget, moved here from `policy-seed.ts` (#1255 P2): the
 * bundle owns its policy rows. This is the legacy row shape the live policy
 * plane seeds today; `MONITOR_WAKE_BUDGET_ROW` below is the same obligation
 * in the frozen #1251 `GateRow` shape the bundle contract carries for
 * `compose` (#1255 S2).
 */
const MONITOR_WAKE_BUDGET: Omit<PolicyRow.Row, "generation"> = {
  name: "monitor-wake-budget",
  kind: "tool",
  phase: "pre",
  priority: 900,
  match: { encodingVersion: 1, value: { op: "monitor" } },
  verdict: {
    encodingVersion: 1,
    value: { type: "obligation", ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
  },
};

/** Seed rows the boot passes to the kernel policy seed until compose owns row tables. */
export const monitorSeedRows: readonly Omit<PolicyRow.Row, "generation">[] = [
  MONITOR_WAKE_BUDGET,
];

const MONITOR_WAKE_BUDGET_ROW: Bundle.BundleGateRow = {
  id: "monitor/tool.pre#1",
  on: "tool.pre",
  when: { op: "monitor" },
  do: "gate",
  how: { ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
  order: 900,
};

/**
 * The monitor bundle's purposes (#1254): the watch plane's two purposes
 * declared over the alarm capability; the `requires: alarm` edge and the
 * capability-off cascade are #1255's compose mechanics.
 */
export function monitorPurposes(deps: Bundle.WatchWakeDeps): Bundle.AlarmBundlePurposes {
  return { bundle: "monitor", purposes: Bundle.watchPurposes(deps) };
}

/** The `monitor` bundle contract (#1255 `Bundle.define`): tool face, wake budget row, purposes. */
export function monitorBundle(
  deps: Bundle.WatchWakeDeps,
): Bundle.BundleContract<"monitor", object, Bundle.AlarmPurposeHandler> {
  return Bundle.define({
    name: "monitor",
    // #1316: the wake-budget row below targets `tool.pre`, so the bundle
    // requires the tool capability's seam — `off: ["tool"]` cascades monitor
    // off instead of rejecting the row as `unknown_point`.
    requires: [Bundle.AlarmSeam, ToolCapabilitySeam],
    // The declaration face; execution ports stay composition-wired until
    // compose (#1255 S2) derives the generation tool table from the manifest.
    tools: [Core.eraseTool(createMonitorTool(undefined))],
    rows: [MONITOR_WAKE_BUDGET_ROW],
    purposes: Object.fromEntries(
      Bundle.watchPurposes(deps).map((purpose) => [purpose.name, purpose.handler]),
    ),
  });
}
