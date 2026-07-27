// server → openomni → agent → llm (direct agent imports forbidden)
import { IngressEngine } from "@openomni/openomni";
import type { ModelCatalogService } from "@openomni/llm";
import type { SecretHandle, SecretRegistry } from "@openomni/llm/credential-runtime";
import type { Adapter, Ingress } from "@openomni/protocol";
import { type Execution, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { resolveRuntimeModel } from "../agents/model-resolution";
import { buildInboundEvent, type BridgeDeps } from "../ingress/bridge";

const OPEN_TASK_STATUS_ORDER: Record<RedactedOpenTaskProjection["status"], number> = {
  failed: 0,
  blocked: 1,
  pending: 2,
  running: 3,
};
const MAX_OPEN_TASKS = 20;
const MAX_DISPLAY_FIELD_CHARS = 80;
const OPEN_TASKS_UNAUTHORIZED_MESSAGE =
  "Open task ledger requires authenticated local WebSocket access";

export type RedactedOpenTaskProjection = {
  readonly id: string;
  readonly name: string;
  readonly status: "pending" | "running" | "blocked" | "failed";
  readonly activeBlockerCount?: number;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly assigneeLabel?: string;
  readonly sessionLabel?: string;
};

export interface OwnerTaskProjectionQuery {
  listOpenTasks(): Promise<readonly RedactedOpenTaskProjection[]>;
}

export interface ConversationHandlerDeps extends BridgeDeps {
  readonly ownerTaskQueries: OwnerTaskProjectionQuery;
  readonly modelCatalog: ModelCatalogService;
  readonly secretRegistry: SecretRegistry;
  readonly credentialHandle: SecretHandle;
  readonly modelEnvironment: Execution.LLMEnvironmentV1;
}

function toResponseText(result: Ingress.IngressResult): string | null {
  if (result.kind === "dropped") return null;
  return result.result.output || "(no response)";
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function canReadTaskLedger(message: Adapter.InboundMessage): boolean {
  if (message.surfaceKey.split(":", 1)[0] !== "ws") return false;
  if (!isWebSocketRaw(message.raw)) return false;
  return message.raw.websocket.authenticated === true;
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

function formatOpenTask(item: RedactedOpenTaskProjection): string {
  const details = [`id: ${formatDisplayField(item.id)}`];
  if (item.activeBlockerCount !== undefined) details.push(`blockers: ${item.activeBlockerCount}`);
  if (item.attempt !== undefined && item.maxAttempts !== undefined) {
    details.push(`attempts: ${item.attempt}/${item.maxAttempts}`);
  }
  if (item.assigneeLabel) details.push(`assignee: ${formatDisplayField(item.assigneeLabel)}`);
  if (item.sessionLabel) details.push(`session: ${formatDisplayField(item.sessionLabel)}`);
  return `- [${item.status}] ${formatDisplayField(item.name)} (${details.join(", ")})`;
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

async function listOpenTasks(queries: OwnerTaskProjectionQuery): Promise<string> {
  const tasks = [...(await queries.listOpenTasks())].sort((a, b) => {
    const statusDelta = OPEN_TASK_STATUS_ORDER[a.status] - OPEN_TASK_STATUS_ORDER[b.status];
    if (statusDelta !== 0) return statusDelta;
    const nameDelta = compareStable(a.name, b.name);
    if (nameDelta !== 0) return nameDelta;
    return compareStable(a.id, b.id);
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

async function processMessage(
  message: Adapter.InboundMessage,
  deps: ConversationHandlerDeps,
): Promise<string | null> {
  try {
    if (normalizeCommand(message.text) === "show open tasks") {
      if (!canReadTaskLedger(message)) return OPEN_TASKS_UNAUTHORIZED_MESSAGE;
      return listOpenTasks(deps.ownerTaskQueries);
    }
    const event = buildInboundEvent(message, deps);
    const resolvedModel = await resolveRuntimeModel({
      model: event.agent.model,
      modelCatalog: deps.modelCatalog,
      secretRegistry: deps.secretRegistry,
      credentialHandle: deps.credentialHandle,
      modelEnvironment: deps.modelEnvironment,
    });
    event.agent.model = {
      provider: resolvedModel.model.provider,
      id: resolvedModel.model.id,
    };
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

export function createMessageHandler(deps: ConversationHandlerDeps): Adapter.MessageHandler {
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
