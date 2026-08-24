import { describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { admit, type Admitted } from "../src/delegation/admission";
import { createChannelDriver } from "../src/delegation/channel-driver";
import { createDelegationKernel } from "../src/delegation/kernel";

const NOW = 1_000_000;
const DEADLINE = NOW + 5_000;

function admitted(): Admitted {
  const decision = admit(
    {
      address: { kind: "actor", actorId: "alice" },
      mode: "assign",
      payload: { text: "review the report" },
      acceptanceCriteria: ["every section read"],
      deadline: DEADLINE,
    },
    { role: "resident", depth: 0, sessionId: "session-origin" },
    NOW,
    { maxInlineDepth: 2 },
  );
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}

const HANDLE = {
  delegationId: "delegation-1",
  address: { kind: "actor", actorId: "alice" },
  transport: "channel",
} as const;

function sentReceipt(input: Gateway.SendInput): Gateway.SendReceipt {
  const spec = input.waitSpec;
  if (spec === undefined) throw new Error("channel driver must send awaited");
  return {
    kind: "sent",
    operation: "awaited",
    messageId: input.messageId,
    senderId: input.senderId,
    grantId: "grant-1",
    target: { actorId: "alice", endpointId: "ws:alice", channel: "ws", externalId: "alice" },
    wait: {
      id: spec.waitId,
      ownerRef: spec.ownerRef,
      originMessageId: input.messageId,
      correlation: { endpointId: "ws:alice", replyToMessageId: input.messageId },
      allowedActions: spec.allowedActions,
      expectedResponders: spec.expectedResponders,
      resolutionPolicy: spec.resolutionPolicy,
      status: "open",
      partial: false,
      replies: [],
      revision: 0,
      expiresAt: spec.expiresAt,
      followUpWindow: spec.followUpWindow,
      createdAt: input.at,
      updatedAt: input.at,
    },
    at: input.at,
  };
}

describe("channel delegation driver", () => {
  test("sends the instruction as an awaited message whose Wait belongs to the originating session", async () => {
    const sent: Gateway.SendInput[] = [];
    const driver = createChannelDriver({
      send: async (input) => {
        sent.push(input);
        return sentReceipt(input);
      },
      now: () => NOW,
      newWaitId: () => "wait-1",
    });

    const outcome = driver.run(admitted(), HANDLE, new AbortController().signal);
    // The pending entry is registered synchronously BEFORE the send, so a
    // reply may race the send's own return and still settle the delegation.
    expect(driver.resume("wait-1", "all sections reviewed")).toBe(true);
    expect(await outcome).toEqual({ status: "completed", output: "all sections reviewed" });

    const input = sent[0];
    if (input === undefined) throw new Error("nothing was sent");
    expect(input.messageId).toBe("delegation-1");
    expect(input.senderId).toBe("resident");
    expect(input.operation).toBe("awaited");
    expect(input.target).toEqual({ actorId: "alice" });
    // The body is the same rendered contract text an inline worker reads.
    expect(input.body).toBe(
      "review the report\n\nIt is done when all of these hold:\n- every section read",
    );
    expect(input.waitSpec).toEqual({
      waitId: "wait-1",
      ownerRef: { kind: "session", id: "session-origin" },
      allowedActions: ["report_result"],
      expectedResponders: ["alice"],
      resolutionPolicy: "first_reply",
      expiresAt: DEADLINE,
      followUpWindow: 0,
    });
  });

  test("a settled wait resumes exactly once", async () => {
    const driver = createChannelDriver({
      send: async (input) => sentReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-1",
    });
    const outcome = driver.run(admitted(), HANDLE, new AbortController().signal);
    expect(driver.resume("wait-1", "done")).toBe(true);
    expect(driver.resume("wait-1", "done again")).toBe(false);
    expect(await outcome).toEqual({ status: "completed", output: "done" });
  });

  test("resume with a waitId nothing is awaiting is refused", () => {
    const driver = createChannelDriver({
      send: async (input) => sentReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-1",
    });
    expect(driver.resume("wait-unknown", "hello")).toBe(false);
  });

  test("a denied send settles delivery_failed and stops awaiting the reply", async () => {
    const driver = createChannelDriver({
      send: async (input) => ({
        kind: "denied",
        code: "target_stale",
        messageId: input.messageId,
        senderId: input.senderId,
        targetActorId: "alice",
        reason: "actor alice has no allocated endpoint",
        at: input.at,
      }),
      now: () => NOW,
      newWaitId: () => "wait-1",
    });
    const outcome = await driver.run(admitted(), HANDLE, new AbortController().signal);
    expect(outcome).toEqual({
      status: "delivery_failed",
      reason: "actor alice has no allocated endpoint",
    });
    expect(driver.resume("wait-1", "too late")).toBe(false);
  });

  test("a delivery effect that throws settles delivery_failed", async () => {
    const driver = createChannelDriver({
      send: async () => {
        throw new Error("no live websocket connection for actor alice");
      },
      now: () => NOW,
      newWaitId: () => "wait-1",
    });
    const outcome = await driver.run(admitted(), HANDLE, new AbortController().signal);
    expect(outcome).toEqual({
      status: "delivery_failed",
      reason: "no live websocket connection for actor alice",
    });
    expect(driver.resume("wait-1", "too late")).toBe(false);
  });

  test("the kernel's deadline abort ends the pending reply, and silence settles no_response", async () => {
    const driver = createChannelDriver({
      send: async (input) => sentReceipt(input),
      now: () => Date.now(),
      newWaitId: () => "wait-1",
    });
    const kernel = createDelegationKernel({
      drivers: { channel: driver },
      now: () => Date.now(),
      newDelegationId: () => "delegation-1",
    });

    const result = await kernel.delegate(
      {
        address: { kind: "actor", actorId: "alice" },
        mode: "assign",
        payload: { text: "review the report" },
        acceptanceCriteria: ["every section read"],
        deadline: Date.now() + 30,
      },
      { role: "resident", depth: 0, sessionId: "session-origin" },
    );

    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled.status).toBe("no_response");
    // The abort cleaned the pending entry: a reply after the deadline finds
    // nothing to settle and falls through to the Resident as a message.
    expect(driver.resume("wait-1", "too late")).toBe(false);
  });

  test("only the Resident reaches the channel transport", async () => {
    const decision = admit(
      {
        address: { kind: "actor", actorId: "alice" },
        mode: "assign",
        payload: { text: "review the report" },
        acceptanceCriteria: ["every section read"],
        deadline: DEADLINE,
      },
      { role: "worker", depth: 1, sessionId: "session-origin" },
      NOW,
      { maxInlineDepth: 2 },
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("a worker must not delegate to an actor");
    expect(decision.reason).toContain("same-domain inline child");
  });
});
