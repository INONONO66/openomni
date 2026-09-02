import { describe, expect, test } from "bun:test";
import type { Delegation, Gateway } from "@openomni/protocol";
import { admit, type AdmissionLease } from "../src/delegation/admission";
import { createChannelDriver } from "../src/delegation/channel-driver";
import { createDelegationKernel, type LeaseLinkage } from "../src/delegation/kernel";
import type { LeasePort } from "../src/tools/mutation/lease";
import { RESIDENT, useDelegationStore } from "./helpers/delegation";
import { dispatchModelTool, modelToolOutput } from "./helpers/tool-dispatch";

useDelegationStore();

const NOW = 1_000_000;
const DEADLINE = NOW + 5_000;
const LIMITS = { maxInlineDepth: 2, maxFanout: 8 } as const;

const leaseOpen = (port: LeasePort, now?: () => number) =>
  modelToolOutput("lease_open", { leases: port }, RESIDENT, now);

const LEASE: AdmissionLease = {
  id: "lease-1",
  conversationId: "conv-1",
  holderDelegationId: "d-parent",
  contactId: "alice",
};

const WORKER_OF_PARENT: Delegation.Origin = {
  role: "worker",
  depth: 1,
  sessionId: "session-origin",
  parentDelegationId: "d-parent",
  rootDelegationId: "d-parent",
};

const PARENT = {
  delegationId: "d-parent",
  rootDelegationId: "d-parent",
  deadline: DEADLINE,
  status: "open",
} as const;

function channelAsk(actorId = "alice"): Delegation.Request {
  return {
    address: { kind: "actor", actorId },
    operation: "ask",
    payload: { text: "confirm the meeting time" },
    deadline: DEADLINE,
  };
}

function admitWorker(request: Delegation.Request, leases: readonly AdmissionLease[]) {
  return admit(request, WORKER_OF_PARENT, NOW, LIMITS, {
    delegationId: "d-child",
    rootDelegationId: "d-parent",
    parent: PARENT,
    openFanout: 1,
    leases,
  });
}

describe("lease admission relaxation (§3.5)", () => {
  test("a worker holding a live lease for the contact reaches the channel, lease pinned", () => {
    const decision = admitWorker(channelAsk(), [LEASE]);
    expect(decision).toMatchObject({ ok: true, transport: "channel", lease: LEASE });
  });

  test("§8.1: the lease admits ONE contact — a third party is refused", () => {
    const decision = admitWorker(channelAsk("mallory"), [LEASE]);
    expect(decision).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
  });

  test("a worker with no lease stays refused at the channel", () => {
    const decision = admitWorker(channelAsk(), []);
    expect(decision).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
  });

  test("§8.5: an inline child of the lease holder does not inherit the lease", () => {
    // The grandchild's parent is the INLINE CHILD's delegation id, not the
    // lease holder's — the holder match fails by construction.
    const grandchildOrigin: Delegation.Origin = {
      role: "worker",
      depth: 2,
      sessionId: "session-origin",
      parentDelegationId: "d-child-inline",
      rootDelegationId: "d-parent",
    };
    const decision = admit(channelAsk(), grandchildOrigin, NOW, LIMITS, {
      delegationId: "d-grandchild",
      rootDelegationId: "d-parent",
      parent: {
        delegationId: "d-child-inline",
        rootDelegationId: "d-parent",
        deadline: DEADLINE,
        status: "open",
      },
      openFanout: 2,
      leases: [LEASE],
    });
    expect(decision).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
  });

  test("the relaxation covers channel addresses only — process stays refused", () => {
    const decision = admitWorker(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "spawn" },
        deadline: DEADLINE,
      },
      [LEASE],
    );
    expect(decision).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
  });
});

describe("lease-pinned channel dispatch", () => {
  test("the driver pins every send to the lease and its conversation, converse class", async () => {
    const sent: Gateway.SendInput[] = [];
    const driver = createChannelDriver({
      send: async (input) => {
        sent.push(input);
        return {
          kind: "sent",
          operation: "fire_and_forget",
          messageId: input.messageId,
          senderId: input.senderId,
          grantId: `lease:${input.leaseId ?? ""}`,
          target: { actorId: "alice", endpointId: "e", channel: "ws", externalId: "alice" },
          at: input.at,
        };
      },
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: {
        open: () => {
          throw new Error("a lease send must never open a second window");
        },
        get: () => undefined,
      },
    });
    const decision = admitWorker(
      { ...channelAsk(), operation: "notify" } as Delegation.Request,
      [LEASE],
    );
    if (!decision.ok) throw new Error(decision.reason);
    const outcome = await driver.run(
      decision,
      {
        delegationId: "d-child",
        operation: "notify",
        address: { kind: "actor", actorId: "alice" },
        transport: "channel",
        deadline: DEADLINE,
        rootDelegationId: "d-parent",
      },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "sent" });
    expect(sent[0]).toMatchObject({
      leaseId: "lease-1",
      conversationId: "conv-1",
      class: "converse",
      senderId: "resident",
    });
  });

  test("an awaited lease ask reuses the lease's window instead of opening one", async () => {
    const controller = new AbortController();
    const driver = createChannelDriver({
      send: async (input) => ({
        kind: "sent",
        operation: "awaited",
        messageId: input.messageId,
        senderId: input.senderId,
        grantId: `lease:${input.leaseId ?? ""}`,
        target: { actorId: "alice", endpointId: "e", channel: "ws", externalId: "alice" },
        wait: {
          id: "wait-1",
          expiresAt: DEADLINE,
        } as never,
        at: input.at,
      }),
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: {
        open: () => {
          throw new Error("a lease send must never open a second window");
        },
        get: () => undefined,
      },
    });
    const decision = admitWorker(channelAsk(), [LEASE]);
    if (!decision.ok) throw new Error(decision.reason);
    const outcome = driver.run(
      decision,
      {
        delegationId: "d-child",
        operation: "ask",
        address: { kind: "actor", actorId: "alice" },
        transport: "channel",
        deadline: DEADLINE,
        waitId: "wait-1",
        rootDelegationId: "d-parent",
      },
      controller.signal,
    );
    controller.abort();
    await expect(outcome).resolves.toEqual({ status: "cancelled", reason: "delegation stopped" });
  });
});

interface CloseCall {
  readonly holder: string;
  readonly closedBy: "settled" | "cancelled" | "deadline";
}

function recordingLinkage(): LeaseLinkage & { closes: CloseCall[]; reads: string[] } {
  const closes: CloseCall[] = [];
  const reads: string[] = [];
  return {
    closes,
    reads,
    listLiveByHolder: (holder) => {
      reads.push(holder);
      return [];
    },
    closeByHolder: (holder, closedBy) => {
      closes.push({ holder, closedBy });
      return closes.length;
    },
  };
}

describe("lease lifecycle inverses in the kernel (§8.6)", () => {
  test("a completed settlement closes the holder's leases as settled", async () => {
    const leases = recordingLinkage();
    const kernel = createDelegationKernel({
      drivers: { inline: { run: async () => ({ status: "completed", output: "ok" }) } },
      now: () => Date.now(),
      newDelegationId: () => "d-done",
      wake: () => undefined,
      limits: LIMITS,
      leases,
    });
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "inline" },
        operation: "ask",
        payload: { text: "do" },
        deadline: Date.now() + 60_000,
      },
      RESIDENT,
    );
    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled?.status).toBe("completed");
    expect(leases.closes).toEqual([{ holder: "d-done", closedBy: "settled" }]);
    // A resident origin never consults live leases at admission.
    expect(leases.reads).toEqual([]);
    kernel.stop();
  });

  test("a cancellation closes the holder's leases as cancelled", async () => {
    const leases = recordingLinkage();
    const kernel = createDelegationKernel({
      drivers: {
        process: {
          run: (_admitted, _handle, signal) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({ status: "cancelled", reason: "stopped" }),
              ),
            ),
        },
      },
      now: () => Date.now(),
      newDelegationId: () => "d-cancelled",
      wake: () => undefined,
      limits: LIMITS,
      leases,
    });
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "do" },
        deadline: Date.now() + 60_000,
      },
      RESIDENT,
    );
    if ("refused" in result) throw new Error(result.refused);
    await kernel.cancelDelegation("d-cancelled");
    expect(leases.closes).toEqual([{ holder: "d-cancelled", closedBy: "cancelled" }]);
    kernel.stop();
  });

  test("a deadline settlement closes the holder's leases as deadline", async () => {
    const leases = recordingLinkage();
    const kernel = createDelegationKernel({
      drivers: {
        inline: {
          run: (_admitted, _handle, signal) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({ status: "cancelled", reason: "stopped" }),
              ),
            ),
        },
      },
      now: () => Date.now(),
      newDelegationId: () => "d-expired",
      wake: () => undefined,
      limits: LIMITS,
      leases,
    });
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "inline" },
        operation: "ask",
        payload: { text: "do" },
        deadline: Date.now() + 25,
      },
      RESIDENT,
    );
    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled?.status).toBe("no_response");
    expect(leases.closes).toEqual([{ holder: "d-expired", closedBy: "deadline" }]);
    kernel.stop();
  });
});

describe("lease_open tool", () => {
  const openDelegation = {
    delegationId: "d-parent",
    status: "open",
    deadline: DEADLINE,
  } as Delegation.Record;

  test("issues a lease bounded by the delegation's deadline", async () => {
    const issued: unknown[] = [];
    const run = leaseOpen(
      {
        issue: ((input: object) => {
          issued.push(input);
          return {
            id: "lease-1",
            conversationId: "conv-1",
            holderDelegationId: "d-parent",
            contactId: "alice",
            expiresAt: DEADLINE,
            budget: { maxOutbound: 3, outboundUsed: 0 },
          };
        }) as never,
        getDelegation: () => openDelegation,
      },
      () => NOW,
    );
    const text = await run({ delegationId: "d-parent", conversationId: "conv-1", maxOutbound: 3 });
    expect(text).toContain("lease lease-1 issued to delegation d-parent");
    expect(issued[0]).toMatchObject({
      conversationId: "conv-1",
      holderDelegationId: "d-parent",
      delegationDeadline: DEADLINE,
      maxOutbound: 3,
    });
  });

  test("refuses a missing or settled delegation and invalid input", async () => {
    const never = () => {
      throw new Error("issue must not be reached");
    };
    const missing = leaseOpen({ issue: never as never, getDelegation: () => undefined });
    expect(await missing({ delegationId: "d-x", conversationId: "c", maxOutbound: 1 })).toBe(
      "lease_open refused: delegation d-x does not exist",
    );
    const settled = leaseOpen({
      issue: never as never,
      getDelegation: () => ({ ...openDelegation, status: "settled" }) as Delegation.Record,
    });
    expect(await settled({ delegationId: "d-parent", conversationId: "c", maxOutbound: 1 })).toBe(
      "lease_open refused: delegation d-parent is already settled",
    );
    const invalid = await dispatchModelTool(
      "lease_open",
      { leases: { issue: never as never, getDelegation: () => openDelegation } },
      RESIDENT,
    )({ maxOutbound: 0 });
    expect(invalid).toMatchObject({ isError: true, errorClass: "invalid_input" });
    expect(invalid.output).toStartWith("\nlease_open refused:");
  });

  test("a store refusal surfaces as the tool's typed refusal text", async () => {
    const run = leaseOpen({
      issue: (() => {
        throw new Error("carve bound exceeded");
      }) as never,
      getDelegation: () => openDelegation,
    });
    expect(await run({ delegationId: "d-parent", conversationId: "c", maxOutbound: 2 })).toBe(
      "lease_open refused: carve bound exceeded",
    );
  });
});
