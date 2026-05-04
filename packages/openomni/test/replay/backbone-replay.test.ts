import { beforeEach, describe, expect, test } from "bun:test";
import { ExecutionEvent, type Message } from "@openomni/protocol";
import { EventLog, Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import {
  ExtensionManager,
  type ExtensionManagerEntry,
  type ExtensionOperationOptions,
} from "../../src/extension";

const fixedDate = new Date("2026-05-04T00:00:00.000Z");
const actor = { kind: "user", id: "tester" };

type MessageSummary = {
  readonly id: string;
  readonly role: Message.Info["role"];
  readonly status: string;
  readonly providerId: string;
  readonly modelId: string;
};

type PartSummary = {
  readonly id: string;
  readonly messageId: string;
  readonly type: string;
  readonly text?: {
    readonly text: string;
    readonly length: number;
    readonly truncated: boolean;
  };
};

type DecisionEvent = Extract<
  ExecutionEvent,
  { type: "action_requested" | "policy_evaluated" | "action_approved" | "action_blocked" }
>;

type DecisionSummary = {
  readonly sequence: number;
  readonly type: DecisionEvent["type"];
  readonly action: string;
  readonly resource: string;
  readonly verdict?: string;
  readonly reason?: string;
};

type ExtensionSummary = {
  readonly id: string;
  readonly version: string;
  readonly state: ExtensionManagerEntry["state"];
  readonly actor: string;
};

type BackboneSummary = {
  readonly messages: readonly MessageSummary[];
  readonly parts: readonly PartSummary[];
  readonly decisions: readonly DecisionSummary[];
  readonly extensions: readonly ExtensionSummary[];
};

describe("backbone EventLog replay", () => {
  beforeEach(() => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
  });

  test("reconstructs session, permission, and extension state from parseable EventLog rows", async () => {
    const session = Session.create({
      title: "backbone replay",
      model: { providerID: "test", modelID: "test-model" },
    });
    const message = makeUserMessage(session.id);
    const part = makeTextPart(session.id, message.id);

    Session.addMessage(session.id, message, { status: "received" });
    Session.addPart(message.id, part);

    const validation = await ExtensionManager.validate(extensionManifest("validated", "1.0.0"), {
      ...operationOptions(session.id),
      permission: { action: "extension.validate", allowlist: ["validated"] },
    });
    expect(validation.success).toBe(true);

    await expectRejectsWithMessage(
      ExtensionManager.validate(extensionManifest("blocked", "1.0.0"), {
        ...operationOptions(session.id),
        permission: { action: "extension.validate", denylist: ["blocked"] },
      }),
      "denylist",
    );

    await ExtensionManager.requestInstall(extensionManifest("alpha", "1.0.0"), {
      ...operationOptions(session.id),
      reason: "fixture install",
    });
    await ExtensionManager.approve("alpha", operationOptions(session.id));
    await ExtensionManager.install("alpha", operationOptions(session.id));
    await ExtensionManager.enable("alpha", operationOptions(session.id));
    await ExtensionManager.disable("alpha", {
      ...operationOptions(session.id),
      reason: "fixture disable",
    });

    const extensions = await ExtensionManager.list(operationOptions(session.id));
    const rows = parseRawRows(session.id);
    const actual = summarizeStoredState(session.id, extensions, rows);
    const replayed = await summarizeReplay(session.id);

    expect(replayed.eventCount).toBe(rows.length);
    expect(replayed.summary).toEqual(actual);
    expect(replayed.summary.decisions).toContainEqual(
      expect.objectContaining({
        type: "policy_evaluated",
        action: "extension.validate",
        resource: "validated",
        verdict: "continue",
        reason: "allowlist",
      }),
    );
    expect(replayed.summary.decisions).toContainEqual(
      expect.objectContaining({
        type: "action_blocked",
        action: "extension.validate",
        resource: "blocked",
        verdict: "abort",
        reason: "denylist",
      }),
    );
    expect(replayed.summary.extensions).toEqual([
      { id: "alpha", version: "1.0.0", state: "disabled", actor: "user:tester" },
    ]);
  });
});

function makeUserMessage(sessionID: string): Message.UserMessage {
  return {
    id: "msg-1",
    sessionID,
    role: "user",
    time: { created: 1_714_780_000_000 },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function makeTextPart(sessionID: string, messageID: string): Message.TextPart {
  return {
    id: "part-1",
    sessionID,
    messageID,
    type: "text",
    text: "hello from replay",
    time: { start: 1_714_780_000_001 },
  };
}

function operationOptions(sessionId: string): ExtensionOperationOptions {
  return {
    actor,
    audit: { sessionId },
    now: () => fixedDate,
  };
}

function extensionManifest(id: string, version: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version,
    description: `${id} extension`,
    provenance: { manifestHash: `${id}-${version}-hash` },
  };
}

function parseRawRows(sessionId: string): ExecutionEvent[] {
  const eventLog = Storage.get().eventLog;
  if (!eventLog) throw new Error("test requires EventLog adapter");

  return eventLog.replay(sessionId).map((row) => ExecutionEvent.Schema.parse(JSON.parse(row.data)));
}

function summarizeStoredState(
  sessionId: string,
  extensions: readonly ExtensionManagerEntry[],
  events: readonly ExecutionEvent[],
): BackboneSummary {
  const messages = Session.getMessages(sessionId).map((message) => ({
    id: message.id,
    role: message.role,
    status: messageStatus(message.id),
    ...messageModel(message),
  }));

  const parts = messages.flatMap((message) =>
    Session.getParts(message.id).map((part) => partSummary(part)),
  );

  return {
    messages: sortById(messages),
    parts: sortById(parts),
    decisions: events.filter(isDecisionEvent).map(decisionSummary),
    extensions: extensionSummaries(extensions),
  };
}

async function summarizeReplay(
  sessionId: string,
): Promise<{ readonly eventCount: number; readonly summary: BackboneSummary }> {
  const messages = new Map<string, MessageSummary>();
  const parts = new Map<string, PartSummary>();
  const decisions: DecisionSummary[] = [];
  const extensions = new Map<string, ExtensionSummary>();
  let eventCount = 0;

  for await (const event of EventLog.replay(sessionId)) {
    eventCount += 1;

    if (isDecisionEvent(event)) {
      decisions.push(decisionSummary(event));
      continue;
    }

    if (event.type !== "bus_event") {
      continue;
    }

    if (event.name === "session.message.added") {
      const payload = readRecord(event.payload);
      const messageId = readString(payload, "messageId");
      messages.set(messageId, {
        id: messageId,
        role: readMessageRole(payload),
        status: readString(payload, "status"),
        providerId: readString(payload, "providerId"),
        modelId: readString(payload, "modelId"),
      });
      continue;
    }

    if (event.name === "session.part.added") {
      const payload = readRecord(event.payload);
      const partId = readString(payload, "partId");
      const text = readOptionalRecord(payload, "text");
      parts.set(partId, {
        id: partId,
        messageId: readString(payload, "partMessageId"),
        type: readString(payload, "partType"),
        ...(text !== undefined
          ? {
              text: {
                text: readString(text, "text"),
                length: readNumber(text, "length"),
                truncated: readBoolean(text, "truncated"),
              },
            }
          : {}),
      });
      continue;
    }

    if (isExtensionLifecycleName(event.name)) {
      const payload = readRecord(event.payload);
      const id = readString(payload, "extensionId");
      extensions.set(id, {
        id,
        version: readString(payload, "version"),
        state: readExtensionState(payload),
        actor: readString(payload, "actor"),
      });
    }
  }

  return {
    eventCount,
    summary: {
      messages: sortById([...messages.values()]),
      parts: sortById([...parts.values()]),
      decisions,
      extensions: extensionSummaries([...extensions.values()]),
    },
  };
}

function messageModel(message: Message.Info): {
  readonly providerId: string;
  readonly modelId: string;
} {
  if (message.role === "assistant") {
    return { providerId: message.providerID, modelId: message.modelID };
  }

  return { providerId: message.model.providerID, modelId: message.model.modelID };
}

function messageStatus(messageId: string): string {
  const findByStatus = Storage.get().message.findByStatus;
  if (!findByStatus) return "completed";

  for (const status of ["received", "processing", "completed"]) {
    if (findByStatus(status).some((row) => row.id === messageId)) {
      return status;
    }
  }

  return "completed";
}

function partSummary(part: Message.Part): PartSummary {
  return {
    id: part.id,
    messageId: part.messageID,
    type: part.type,
    ...(part.type === "text" || part.type === "reasoning" ? { text: textSummary(part.text) } : {}),
  };
}

function textSummary(text: string): PartSummary["text"] {
  return {
    text,
    length: text.length,
    truncated: false,
  };
}

function isDecisionEvent(event: ExecutionEvent): event is DecisionEvent {
  return (
    event.type === "action_requested" ||
    event.type === "policy_evaluated" ||
    event.type === "action_approved" ||
    event.type === "action_blocked"
  );
}

function decisionSummary(event: DecisionEvent): DecisionSummary {
  return {
    sequence: event.sequence,
    type: event.type,
    action: event.action,
    resource: event.resource,
    ...(event.type !== "action_requested" ? { verdict: event.verdict, reason: event.reason } : {}),
  };
}

function extensionSummaries(entries: readonly ExtensionSummary[]): ExtensionSummary[];
function extensionSummaries(entries: readonly ExtensionManagerEntry[]): ExtensionSummary[];
function extensionSummaries(
  entries: readonly (ExtensionSummary | ExtensionManagerEntry)[],
): ExtensionSummary[] {
  return [...entries]
    .map((entry) => ({
      id: entry.id,
      version: entry.version,
      state: entry.state,
      actor: entry.actor,
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("expected EventLog payload object");
}

function readOptionalRecord(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return value === undefined ? undefined : readRecord(value);
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value === "string") return value;

  throw new Error(`expected string payload field: ${field}`);
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value === "number") return value;

  throw new Error(`expected number payload field: ${field}`);
}

function readBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value === "boolean") return value;

  throw new Error(`expected boolean payload field: ${field}`);
}

function readMessageRole(record: Record<string, unknown>): MessageSummary["role"] {
  const role = readString(record, "role");
  if (role === "user" || role === "assistant") return role;

  throw new Error(`unexpected message role: ${role}`);
}

function readExtensionState(record: Record<string, unknown>): ExtensionSummary["state"] {
  const state = readString(record, "state");
  if (
    state === "proposed" ||
    state === "approved" ||
    state === "installed" ||
    state === "enabled" ||
    state === "disabled" ||
    state === "rolled_back" ||
    state === "failed"
  ) {
    return state;
  }

  throw new Error(`unexpected extension state: ${state}`);
}

function isExtensionLifecycleName(name: string): boolean {
  return (
    name === "extension.proposed" ||
    name === "extension.approved" ||
    name === "extension.installed" ||
    name === "extension.enabled" ||
    name === "extension.disabled" ||
    name === "extension.rolled_back" ||
    name === "extension.failed"
  );
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caughtError: unknown;
  try {
    await promise;
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect(caughtError instanceof Error ? caughtError.message : "").toContain(message);
}
