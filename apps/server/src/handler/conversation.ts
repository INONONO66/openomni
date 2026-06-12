// server → openomni → agent → llm (direct agent imports forbidden)
import { IngressEngine } from "@openomni/openomni";
import type { Adapter, Ingress } from "@openomni/protocol";
import { Operational, WorkItem } from "@openomni/protocol";
import { Bus, WorkItemStore } from "@openomni/session";
import { resolveRuntimeModel } from "../agents/model-resolution";
import { buildInboundEvent, type BridgeDeps } from "../ingress/bridge";
import { resolveAgentName } from "../router";

const OPEN_TASK_STATUS_ORDER: Record<WorkItem.Status, number> = {
  blocked: 0,
  pending: 1,
  running: 2,
  completed: 3,
  failed: 4,
  cancelled: 5,
};
const MAX_OPEN_TASKS = 20;
const MAX_DISPLAY_FIELD_CHARS = 80;

type OpenTask = {
  readonly item: WorkItem.Info;
  readonly status: WorkItem.Status;
};

function toResponseText(result: Ingress.IngressResult): string {
  return result.result.output || "(no response)";
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatOpenTask(task: OpenTask): string {
  const { item, status } = task;
  const activeBlockers = item.blockers.filter((blocker) => blocker.resolvedAt === undefined).length;
  const details = [`hash: ${item.hash}`];
  if (status === "blocked") details.push(`blockers: ${activeBlockers}`);
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
  const tasks = WorkItemStore.list({ status: ["pending", "running", "blocked"] })
    .map((item) => ({ item, status: WorkItem.deriveStatus(item) }))
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

async function processMessage(message: Adapter.InboundMessage, deps: BridgeDeps): Promise<string> {
  try {
    if (normalizeCommand(message.text) === "show open tasks") return listOpenTasks();
    const agentName = resolveAgentName({ message, defaultAgent: "resident" });
    const event = buildInboundEvent(message, agentName, deps);
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

export function createMessageHandler(deps: BridgeDeps): Adapter.MessageHandler {
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
