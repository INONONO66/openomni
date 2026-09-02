import { describe, expect, it } from "bun:test";
import type { Conversation } from "@openomni/protocol";
import { catalogEntries } from "../src/tools/core/catalog";
import {
  converseCloseToolExecutor,
  converseOpenToolExecutor,
  type ConversePort,
} from "../src/tools/mutation/converse";

const RESIDENT = { role: "resident", depth: 0, sessionId: "session-origin" } as const;
const WORKER = { role: "worker", depth: 1, sessionId: "session-origin" } as const;

function recordingPort(): ConversePort & {
  opened: Conversation.Create[];
  closed: string[];
} {
  const opened: Conversation.Create[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    open: (input) => {
      opened.push(input);
      return { id: input.id, policy: input.policy, contactId: input.contactId } as never;
    },
    get: () => undefined,
    close: (id) => {
      closed.push(id);
      return { kind: "closed", record: { id } } as never;
    },
    closeLeases: () => 0,
  };
}

function failingPort(port: ConversePort, overrides: Partial<ConversePort>): ConversePort {
  return { ...port, ...overrides };
}

describe("converse tools", () => {
  it("converse_open opens a bounded window owned by the caller's session", async () => {
    const port = recordingPort();
    const run = converseOpenToolExecutor(port, RESIDENT, () => 1_000);

    const text = await run({
      contactId: "alice",
      endpointId: "ws:alice",
      timeoutMs: 5_000,
    });

    expect(port.opened).toHaveLength(1);
    expect(port.opened[0]).toMatchObject({
      contactId: "alice",
      endpointId: "ws:alice",
      ownerRef: { kind: "session", id: "session-origin" },
      openedBy: "resident",
      policy: {
        expiresAt: 6_000,
        maxOutbound: 8,
        maxInbound: 32,
        onInboundCapBreach: "demote",
      },
    });
    expect(text).toContain("open to alice until 6000");
  });

  it("converse_open refuses invalid input without touching the store", async () => {
    const port = recordingPort();
    const run = converseOpenToolExecutor(port, RESIDENT);

    const text = await run({ contactId: "alice" });

    expect(text).toContain("converse_open refused:");
    expect(port.opened).toHaveLength(0);
  });

  it("converse_open surfaces a store refusal as text", async () => {
    const port = failingPort(recordingPort(), {
      open: () => {
        throw new Error("storage unavailable");
      },
    });
    const run = converseOpenToolExecutor(port, RESIDENT);

    const text = await run({ contactId: "alice", endpointId: "ws:alice", timeoutMs: 1_000 });

    expect(text).toBe("converse_open refused: storage unavailable");
  });

  it("converse_close settles the window and reports an already-settled one idempotently", async () => {
    const port = recordingPort();
    const run = converseCloseToolExecutor(port);

    expect(await run({ conversationId: "conv:1" })).toBe("conversation conv:1 closed");
    expect(port.closed).toEqual(["conv:1"]);

    const settled = converseCloseToolExecutor(
      failingPort(port, {
        close: () => ({ kind: "unchanged", record: { id: "conv:1", closedBy: "expiry" } }) as never,
      }),
    );
    expect(await settled({ conversationId: "conv:1" })).toBe(
      "conversation conv:1 was already closed (expiry)",
    );
  });

  it("converse_close refuses invalid input without touching the store", async () => {
    const port = recordingPort();
    const run = converseCloseToolExecutor(port);

    const text = await run({});

    expect(text).toContain("converse_close refused:");
    expect(port.closed).toHaveLength(0);
  });

  it("converse_close surfaces a missing window as a typed refusal", async () => {
    const port = failingPort(recordingPort(), {
      close: () => {
        throw new Error("Conversation not found: conv:ghost");
      },
    });
    const run = converseCloseToolExecutor(port);

    expect(await run({ conversationId: "conv:ghost" })).toBe(
      "converse_close refused: Conversation not found: conv:ghost",
    );
  });

  it("the catalog offers the tools to the Resident with the port wired, never to a worker", () => {
    const port = recordingPort();
    const residentTools = catalogEntries({ conversations: port }, RESIDENT).map(
      (entry) => entry.spec.name,
    );
    expect(residentTools).toContain("converse_open");
    expect(residentTools).toContain("converse_close");

    const workerTools = catalogEntries({ conversations: port }, WORKER).map(
      (entry) => entry.spec.name,
    );
    expect(workerTools).not.toContain("converse_open");
    expect(workerTools).not.toContain("converse_close");

    const unwired = catalogEntries({}, RESIDENT).map((entry) => entry.spec.name);
    expect(unwired).not.toContain("converse_open");
  });
});
