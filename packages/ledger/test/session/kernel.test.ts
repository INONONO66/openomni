import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BusEvent,
  type Inbox,
  type LedgerAction,
  L0Observation,
  type ObservationSink,
  type SessionGeneration,
  SessionTurn,
} from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { SessionHandleStore, Storage } from "../../src/index";
import { bareStorageAdapter } from "../helpers/wait";

const SIGNAL_TIMEOUT_MS = 1_000;

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      SIGNAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const system = {
  preset: "Session preset",
  blocks: [{ id: "rules", source: "test", content: "Follow the rules." }],
};

const writeTool: SessionGeneration.Tool = {
  name: "write",
  inputSchema: { type: "object" },
  category: "mutation",
};
const tools: readonly SessionGeneration.Tool[] = [
  writeTool,
  { name: "read", inputSchema: { type: "object" }, category: "query" },
];

class DroppingObservationSink implements ObservationSink {
  dropNextCommit = false;

  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    if (this.dropNextCommit && event.name === L0Observation.ActionCommittedEvent.name) {
      this.dropNextCommit = false;
      return;
    }
    Bus.publish(event, data);
  }

  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    return Bus.subscribe(event, handler, options);
  }
}

let sink: DroppingObservationSink;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  sink = new DroppingObservationSink();
  Storage.initialize({ dbPath: ":memory:", observationSink: sink });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

function materialize(id: string) {
  return SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools,
    system,
    policyGeneration: 0,
    actionId: `${id}:configure`,
    at: 1,
  });
}

function node(action: LedgerAction.Append, ordinal: number): LedgerAction.Node {
  return { ...action, ordinal };
}

function pinned(generation: SessionGeneration.Snapshot) {
  return {
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    policyGeneration: generation.policyGeneration,
  };
}

function turnIntent(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.Intent.parse({
        phase: "intent",
        resultId: input.resultId,
        inboxIds: [],
        ...pinned(input.generation),
        resumeCount: 0,
        boundaryActionId: null,
      }),
    },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: 10,
  };
}

function turnResume(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.Resume.parse({
        phase: "resume",
        turnId: input.turnId,
        resultId: input.resultId,
        ...pinned(input.generation),
        resumeCount: 1,
        boundaryActionId: null,
      }),
    },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: 11,
  };
}

function checkpoint(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly resultId: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "checkpoint", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Checkpoint.parse({
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: 1,
        boundaryActionId: input.id,
        boundary: "after_llm",
      }),
    },
    irreversible: true,
    ts: 12,
  };
}

function terminal(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly kind: SessionTurn.TerminalKind;
  readonly text: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: SessionTurn.TerminalIntent.parse({ phase: "terminal", turnId: input.turnId }),
    },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Terminal.parse({
        phase: "terminal",
        turnId: input.turnId,
        kind: input.kind,
        text: input.text,
        boundaryActionId: input.parentId,
        resumeCount: 1,
      }),
    },
    irreversible: true,
    ts: 13,
  };
}

function delivery(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly inboxId: string;
  readonly content: string;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "inbox.deliver",
    intent: { encodingVersion: 1, value: { inboxId: input.inboxId } },
    effect: {
      encodingVersion: 1,
      value: SessionTurn.Delivery.parse({
        phase: "delivery",
        turnId: input.turnId,
        inboxId: input.inboxId,
        kind: "prompt",
        content: input.content,
        origin: { encodingVersion: 1, value: { source: "test" } },
        boundary: "before_llm",
      }),
    },
    irreversible: true,
    ts: 9,
  };
}

function prompt(
  id: string,
  sessionId: string,
  content: string,
  parentActionId: string,
): Inbox.Commit {
  return {
    id,
    sessionId,
    kind: "prompt",
    content,
    origin: { encodingVersion: 1, value: { source: "test" } },
    createdAt: 5,
    parentActionId,
  };
}

describe("session kernel folds", () => {
  test("canonicalizes generations and decodes every turn action shape", () => {
    const generation = SessionHandleStore.generationSnapshot({
      generation: 2,
      revertTo: 1,
      tools,
      system,
      policyGeneration: 3,
    });
    expect(generation.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    expect(generation.systemValue).toBe("Session preset\n\nFollow the rules.");

    const configured = node(
      SessionHandleStore.configureAction({
        id: "configured",
        sessionId: "folded",
        parentId: null,
        operation: "tools.add",
        snapshot: generation,
        at: 1,
      }),
      1,
    );
    expect(SessionHandleStore.latestGeneration([configured])).toEqual(generation);
    expect(SessionHandleStore.generationByNumber([configured], 2)).toEqual(generation);
    expect(SessionHandleStore.generationByNumber([configured], 1)).toBeUndefined();
    expect(() => SessionHandleStore.latestGeneration([])).toThrow("no configured generation");

    expect(() =>
      SessionHandleStore.generationSnapshot({
        generation: 1,
        revertTo: 0,
        tools: [writeTool, writeTool],
        system,
        policyGeneration: 0,
      }),
    ).toThrow("duplicate tool name");
    expect(() =>
      SessionHandleStore.generationSnapshot({
        generation: 1,
        revertTo: 0,
        tools: [],
        system: {
          preset: "",
          blocks: [
            { id: "duplicate", source: "test", content: "one" },
            { id: "duplicate", source: "test", content: "two" },
          ],
        },
        policyGeneration: 0,
      }),
    ).toThrow("duplicate system block id");

    const intent = node(
      turnIntent({
        id: "turn-1",
        sessionId: "folded",
        parentId: "configured",
        generation,
        resultId: "result-1",
      }),
      2,
    );
    const resumed = node(
      turnResume({
        id: "resume-1",
        sessionId: "folded",
        parentId: "turn-1",
        turnId: "turn-1",
        generation,
        resultId: "result-1",
      }),
      3,
    );
    const checked = node(
      checkpoint({
        id: "checkpoint-1",
        sessionId: "folded",
        parentId: "resume-1",
        turnId: "turn-1",
        resultId: "result-1",
      }),
      4,
    );
    const delivered = node(
      delivery({
        id: "delivery-1",
        sessionId: "folded",
        parentId: "checkpoint-1",
        turnId: "turn-1",
        inboxId: "prompt-1",
        content: "continue",
      }),
      5,
    );
    const closed = node(
      terminal({
        id: "result-1",
        sessionId: "folded",
        parentId: "delivery-1",
        turnId: "turn-1",
        kind: "result",
        text: "done",
      }),
      6,
    );

    expect(SessionHandleStore.turnIntent(intent)?.resultId).toBe("result-1");
    expect(SessionHandleStore.turnResume(resumed)?.resumeCount).toBe(1);
    expect(SessionHandleStore.turnCheckpoint(checked)?.boundaryActionId).toBe("checkpoint-1");
    expect(SessionHandleStore.delivery(delivered)?.content).toBe("continue");
    expect(SessionHandleStore.turnTerminal(closed)?.kind).toBe("result");
    expect(SessionHandleStore.turnIntent(configured)).toBeUndefined();
    expect(SessionHandleStore.delivery(intent)).toBeUndefined();

    expect(SessionHandleStore.openTurns([configured, intent, resumed, checked])).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        resultId: "result-1",
        resumeCount: 1,
        boundaryActionId: "checkpoint-1",
        action: checked,
      }),
    ]);
    expect(SessionHandleStore.openTurns([configured, intent, resumed, checked, closed])).toEqual(
      [],
    );
  });

  test("reads authoritative open and terminal tails from committed session actions", () => {
    const sessionId = "snapshot-session";
    const created = materialize(sessionId);
    const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
    const first = SessionHandleStore.commitInbox(
      prompt("prompt-1", sessionId, "first", "snapshot-session:configure"),
    );
    const second = SessionHandleStore.commitInbox(
      prompt("prompt-2", sessionId, "second", first.id),
    );
    expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([first, second]);
    expect(SessionHandleStore.inboxRows(sessionId)).toEqual([first, second]);

    const lease = SessionHandleStore.acquireLease({
      sessionId,
      owner: "owner",
      expectedFence: created.row.leaseFence,
      now: 10,
      expiresAt: 1_000,
    });
    expect(lease).toEqual({ ok: true, fence: 1 });
    if (!lease.ok) throw new Error("lease acquisition failed");
    expect(
      SessionHandleStore.renewLease({
        sessionId,
        owner: "owner",
        fence: lease.fence,
        now: 11,
        expiresAt: 2_000,
      }),
    ).toBe(true);

    const deliveredFirst = delivery({
      id: "prompt-1:delivery",
      sessionId,
      parentId: second.id,
      turnId: "turn-1",
      inboxId: first.id,
      content: first.content,
    });
    const deliveredSecond = delivery({
      id: "prompt-2:delivery",
      sessionId,
      parentId: deliveredFirst.id,
      turnId: "turn-1",
      inboxId: second.id,
      content: second.content,
    });
    const intent = turnIntent({
      id: "turn-1",
      sessionId,
      parentId: deliveredSecond.id,
      generation,
      resultId: "result-1",
    });
    const running = SessionHandleStore.commit({
      sessionId,
      owner: "owner",
      fence: lease.fence,
      now: 12,
      expectedRevision: SessionHandleStore.row(sessionId).revision,
      actions: [deliveredFirst, deliveredSecond, intent],
      consumeInboxIds: [first.id, second.id],
      state: "running",
      releaseLease: false,
    });
    expect(running.ok).toBe(true);
    expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
    expect(SessionHandleStore.getSnapshot(sessionId)).toMatchObject({
      id: sessionId,
      state: "running",
      openTurnId: "turn-1",
      turns: [{ state: "running", messages: [{ text: "first" }, { text: "second" }] }],
    });

    const continuation = SessionHandleStore.commitInbox(
      prompt("prompt-3", sessionId, "third", "turn-1"),
    );
    const deliveredThird = delivery({
      id: "prompt-3:delivery",
      sessionId,
      parentId: continuation.id,
      turnId: "turn-1",
      inboxId: continuation.id,
      content: continuation.content,
    });
    const checked = checkpoint({
      id: "checkpoint-1",
      sessionId,
      parentId: deliveredThird.id,
      turnId: "turn-1",
      resultId: "result-1",
    });
    expect(
      SessionHandleStore.commit({
        sessionId,
        owner: "owner",
        fence: lease.fence,
        now: 13,
        expectedRevision: SessionHandleStore.row(sessionId).revision,
        actions: [deliveredThird, checked],
        consumeInboxIds: [continuation.id],
        state: "running",
        releaseLease: false,
      }).ok,
    ).toBe(true);
    const result = terminal({
      id: "result-1",
      sessionId,
      parentId: checked.id,
      turnId: "turn-1",
      kind: "result",
      text: "answer",
    });
    expect(
      SessionHandleStore.commit({
        sessionId,
        owner: "owner",
        fence: lease.fence,
        now: 14,
        expectedRevision: SessionHandleStore.row(sessionId).revision,
        actions: [result],
        consumeInboxIds: [],
        state: "idle",
        releaseLease: true,
      }).ok,
    ).toBe(true);

    expect(SessionHandleStore.getSnapshot(sessionId)).toMatchObject({
      state: "idle",
      turns: [
        {
          turnId: "turn-1",
          state: "idle",
          terminal: { kind: "result", actionId: "result-1" },
          messages: [
            { role: "user", text: "first" },
            { role: "user", text: "second" },
            { role: "user", text: "third" },
            { role: "assistant", text: "answer" },
          ],
        },
      ],
    });
    expect(SessionHandleStore.getSnapshot(sessionId, 0).turns).toEqual([]);
    expect(() => SessionHandleStore.getSnapshot(sessionId, -1)).toThrow(
      "turn count must be non-negative",
    );
    expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual([sessionId]);
  });

  test("watch emits revisions and gaps, then releases all subscribers", async () => {
    materialize("watched");
    const watch = SessionHandleStore.watchSnapshot("watched", 1, sink);
    const seen: SessionTurn.Observation[] = [];
    let resolveObservations: () => void = () => undefined;
    const observations = new Promise<void>((resolve) => {
      resolveObservations = resolve;
    });
    const stopHandler = watch.subscribe((observation) => {
      seen.push(observation);
      if (seen.length === 2) resolveObservations();
    });

    SessionHandleStore.commitInbox(prompt("watch-1", "watched", "one", "watched:configure"));
    sink.dropNextCommit = true;
    SessionHandleStore.commitInbox(prompt("watch-2", "watched", "two", "watch-1"));
    SessionHandleStore.commitInbox(prompt("watch-3", "watched", "three", "watch-2"));
    await bounded(observations, "watch observations");

    expect(seen).toEqual([
      expect.objectContaining({ kind: "revision", sessionId: "watched", revision: 2 }),
      { kind: "gap", sessionId: "watched", from: 2, to: 4 },
    ]);
    expect(SessionHandleStore.getSnapshot("watched").revision).toBe(4);
    stopHandler();
    watch.unsubscribe();
    watch.unsubscribe();
    expect(() => watch.subscribe(() => undefined)).toThrow("watch is unsubscribed");
  });

  test("wrapper failures stay loud when rows or required capabilities are absent", () => {
    expect(() => SessionHandleStore.row("missing")).toThrow("session not found");
    expect(() =>
      SessionHandleStore.acquireLease({
        sessionId: "missing",
        owner: "owner",
        expectedFence: 0,
        now: 1,
        expiresAt: 2,
      }),
    ).toThrow("session not found");
    expect(() =>
      SessionHandleStore.commit({
        sessionId: "missing",
        owner: "owner",
        fence: 1,
        now: 1,
        expectedRevision: 0,
        actions: [],
        consumeInboxIds: [],
        state: "idle",
        releaseLease: true,
      }),
    ).toThrow("session not found");
    expect(() =>
      SessionHandleStore.commitInbox(
        prompt("missing-prompt", "missing", "missing", "missing-parent"),
      ),
    ).toThrow("inbox commit refused");

    const policies = Storage.get().policies;
    if (policies === undefined) throw new Error("policy adapter is unavailable");
    expect(SessionHandleStore.currentPolicyGeneration()).toBe(0);
    expect(
      policies.append({
        name: "configure",
        kind: "session.configure",
        phase: "pre",
        match: { encodingVersion: 1, value: {} },
        verdict: { encodingVersion: 1, value: { kind: "allow" } },
        priority: 0,
        generation: 4,
      }),
    ).toBe(true);
    expect(SessionHandleStore.currentPolicyGeneration()).toBe(4);

    Storage.configure(bareStorageAdapter());
    expect(() => SessionHandleStore.row("missing")).toThrow("capability is unavailable: sessions");
    expect(() => SessionHandleStore.tree("missing")).toThrow("capability is unavailable: actions");
    expect(() => SessionHandleStore.pendingInbox("missing")).toThrow(
      "capability is unavailable: inbox",
    );
    expect(() => SessionHandleStore.currentPolicyGeneration()).toThrow(
      "capability is unavailable: policies",
    );
    expect(() =>
      SessionHandleStore.watchSnapshot("missing", 1, { publish: () => undefined }),
    ).toThrow("requires a subscribable observation sink");
  });
});
