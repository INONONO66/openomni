// server → openomni → agent → llm (direct agent imports forbidden)
import { IngressEngine } from "@openomni/openomni";
import type { Adapter, Ingress } from "@openomni/protocol";
import { Operational, WorkItem } from "@openomni/protocol";
import { Bus, hasRetryExhaustionBlocker, SurfaceKey, WorkItemStore } from "@openomni/session";
import type { DispatchRuntime } from "@openomni/openomni";
import { resolveRuntimeModel } from "../agents/model-resolution";
import {
  buildActorMessageCorrelation,
  buildInboundEvent,
  type BridgeDeps,
} from "../ingress/bridge";

const OPEN_TASK_STATUSES = [
  "pending",
  "running",
  "blocked",
  "failed",
] as const satisfies readonly WorkItem.Status[];
type OpenTaskStatus = (typeof OPEN_TASK_STATUSES)[number];

const OPEN_TASK_STATUS_SET: ReadonlySet<WorkItem.Status> = new Set(OPEN_TASK_STATUSES);
const OPEN_TASK_STATUS_ORDER: Record<OpenTaskStatus, number> = {
  failed: 0,
  blocked: 1,
  pending: 2,
  running: 3,
};
const MAX_OPEN_TASKS = 20;
const MAX_DISPLAY_FIELD_CHARS = 80;
const OPEN_TASKS_UNAUTHORIZED_MESSAGE =
  "Open task ledger requires authenticated local WebSocket access";
const PI_FALLBACK_REASONS = new Set([
  "dispatch.actor.required",
  "dispatch.pending_interaction.required",
]);

interface MessageHandlerDeps extends BridgeDeps {
  readonly dispatchRuntime?: Pick<DispatchRuntime, "submit">;
}

type OpenTask = {
  readonly item: WorkItem.Info;
  readonly status: OpenTaskStatus;
};

function toResponseText(result: Ingress.IngressResult): string {
  return result.result.output || "(no response)";
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function canReadTaskLedger(message: Adapter.InboundMessage): boolean {
  const surface = SurfaceKey.parse(message.surfaceKey).surface;
  if (surface !== "ws") return false;
  if (!isWebSocketRaw(message.raw)) return false;
  return message.raw.websocket.authenticated === true;
}

function isOpenTaskStatus(status: WorkItem.Status): status is OpenTaskStatus {
  return OPEN_TASK_STATUS_SET.has(status);
}

function isLedgerVisibleTask(item: WorkItem.Info, status: OpenTaskStatus): boolean {
  return status !== "failed" || hasRetryExhaustionBlocker(item);
}

function isWebSocketRaw(raw: unknown): raw is { websocket: { authenticated: boolean } } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "websocket" in raw &&
    typeof raw.websocket === "object" &&
    raw.websocket !== null &&
    "authenticated" in raw.websocket &&
    typeof raw.websocket.authenticated === "boolean"
  );
}

function formatOpenTask(task: OpenTask): string {
  const { item, status } = task;
  const activeBlockers = item.blockers.filter((blocker) => blocker.resolvedAt === undefined).length;
  const details = [`hash: ${item.hash}`];
  if (status === "blocked" || status === "failed") details.push(`blockers: ${activeBlockers}`);
  if (status === "failed" && item.maxAttempts !== undefined) {
    details.push(`attempts: ${item.attempt}/${item.maxAttempts}`);
  }
  if (item.assigneeId) details.push(`assignee: ${formatDisplayField(item.assigneeId)}`);
  if (item.sessionId) details.push(`session: ${formatDisplayField(item.sessionId)}`);
  return `- [${status}] ${formatDisplayField(item.name)} (${details.join(", ")})`;
}

function formatDisplayField(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= MAX_DISPLAY_FIELD_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DISPLAY_FIELD_CHARS - 3)}...`;
}

function compareStable(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function listOpenTasks(): string {
  const tasks = WorkItemStore.list({ status: [...OPEN_TASK_STATUSES] })
    .flatMap((item): OpenTask[] => {
      const status = WorkItem.deriveStatus(item);
      return isOpenTaskStatus(status) && isLedgerVisibleTask(item, status)
        ? [{ item, status }]
        : [];
    })
    .sort((a, b) => {
      const statusDelta = OPEN_TASK_STATUS_ORDER[a.status] - OPEN_TASK_STATUS_ORDER[b.status];
      if (statusDelta !== 0) return statusDelta;
      const nameDelta = compareStable(a.item.name, b.item.name);
      if (nameDelta !== 0) return nameDelta;
      return compareStable(a.item.hash, b.item.hash);
    });
  if (tasks.length === 0) return "Open tasks: none";
  const visibleTasks = tasks.slice(0, MAX_OPEN_TASKS);
  const remaining = tasks.length - visibleTasks.length;
  return [
    `Open tasks (${tasks.length})`,
    ...visibleTasks.map(formatOpenTask),
    ...(remaining > 0 ? [`...and ${remaining} more`] : []),
  ].join("\n");
}

function responseText(result: unknown): string | null {
  if (typeof result === "string") return result;
  return null;
}

async function dispatchPendingInteractionReply(
  message: Adapter.InboundMessage,
  deps: MessageHandlerDeps,
): Promise<string | null | undefined> {
  if (!deps.dispatchRuntime) return undefined;

  const result = await deps.dispatchRuntime.submit(
    {
      action: "actor.message",
      target: { kind: "surface", id: message.surfaceKey },
      payload: message.text,
      correlation: buildActorMessageCorrelation(message),
    },
    {
      actorKind: "unknown",
      actorId: message.sender.id,
      workspaceRoot: deps.workspaceRoot,
    },
  );

  if (result.status === "completed") return responseText(result.output);
  const reason = result.reason ?? result.error;
  if (reason && PI_FALLBACK_REASONS.has(reason)) return undefined;
  return `Error: ${reason ?? `dispatch ${result.status}`}`;
}

async function processMessage(
  message: Adapter.InboundMessage,
  deps: MessageHandlerDeps,
): Promise<string | null> {
  try {
    if (normalizeCommand(message.text) === "show open tasks") {
      if (!canReadTaskLedger(message)) return OPEN_TASKS_UNAUTHORIZED_MESSAGE;
      return listOpenTasks();
    }
    const pendingInteractionReply = await dispatchPendingInteractionReply(message, deps);
    if (pendingInteractionReply !== undefined) return pendingInteractionReply;

    const event = buildInboundEvent(message, "resident", deps);
    event.agent.model = await resolveRuntimeModel(event.agent.model, deps.defaultModel);
    return toResponseText(await IngressEngine.ingest(event));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Bus.publish(Operational.Error, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "ingress error",
      context: { msg },
    });
    return `Error: ${msg}`;
  }
}

export function createMessageHandler(deps: MessageHandlerDeps): Adapter.MessageHandler {
  const queues = new Map<string, Promise<void>>();
  return async (message) => {
    const key = message.surfaceKey;
    const prev = queues.get(key) ?? Promise.resolve();
    let text: string | null = null;
    const current: Promise<void> = prev
      .catch(() => undefined)
      .then(async () => {
        text = await processMessage(message, deps);
      });
    queues.set(key, current);
    try {
      await current;
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
    return text ? { text } : null;
  };
}
