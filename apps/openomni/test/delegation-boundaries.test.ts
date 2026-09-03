import { describe, expect, test } from "bun:test";
import type { Delegation } from "@openomni/protocol";
import { admit, type Admitted } from "../src/delegation/admission";
import { createChannelDriver } from "../src/delegation/channel-driver";
import { createInlineDriver } from "../src/delegation/inline-driver";
import { WorkerRunError } from "../src/delegation/worker-loop";

const NOW = 100;
const request = {
  address: { kind: "core", scope: "inline" },
  operation: "ask",
  payload: { text: "work" },
  deadline: 200,
} as const;
const resident = { role: "resident", depth: 0, sessionId: "session" } as const;

function channelAdmission(): Admitted {
  const result = admit(
    { ...request, address: { kind: "actor", actorId: "actor" } },
    resident,
    NOW,
    { maxInlineDepth: 2 },
    { delegationId: "d", rootDelegationId: "d", openFanout: 0 },
  );
  if (!result.ok) throw result.error;
  return result;
}

const handle: Delegation.Handle = {
  delegationId: "d",
  operation: "ask",
  address: { kind: "actor", actorId: "actor" },
  transport: "channel",
  deadline: 200,
  rootDelegationId: "d",
};

describe("delegation defensive boundaries", () => {
  test("admission rejects malformed origins and inconsistent durable parents", () => {
    expect(admit(request, { role: "worker" } as never, NOW, { maxInlineDepth: 2 }).ok).toBe(false);
    const worker = {
      role: "worker",
      depth: 1,
      sessionId: "session",
      parentDelegationId: "parent",
      rootDelegationId: "root",
    } as const;
    expect(
      admit(
        request,
        worker,
        NOW,
        { maxInlineDepth: 2 },
        {
          delegationId: "child",
          rootDelegationId: "root",
          openFanout: 0,
        },
      ).ok,
    ).toBe(false);
    expect(
      admit(
        request,
        worker,
        NOW,
        { maxInlineDepth: 2 },
        {
          delegationId: "child",
          rootDelegationId: "other-root",
          openFanout: 0,
          parent: {
            delegationId: "different-parent",
            rootDelegationId: "root",
            deadline: 200,
            status: "open",
          },
        },
      ).ok,
    ).toBe(false);
  });

  test("channel transport rejects impossible non-actor and missing-wait states", async () => {
    const driver = createChannelDriver({
      send: () => Promise.reject(new Error("not reached")),
      now: () => NOW,
      newWaitId: () => "wait",
    });
    const invalid = {
      ...channelAdmission(),
      request: { ...request, address: { kind: "core", scope: "inline" } },
    } as Admitted;
    expect(() => driver.prepare(invalid, handle)).toThrow();
    await expect(driver.run(invalid, handle, new AbortController().signal)).rejects.toThrow();
    await expect(
      driver.run(channelAdmission(), handle, new AbortController().signal),
    ).rejects.toThrow();
  });

  test("channel transport rejects an awaited send receipt without a wait", async () => {
    const driver = createChannelDriver({
      send: async (input) => ({
        kind: "sent",
        operation: "fire_and_forget",
        messageId: input.messageId,
        senderId: input.senderId,
        grantId: "grant",
        target: { actorId: "actor", endpointId: "endpoint", channel: "ws", externalId: "actor" },
        at: input.at,
      }),
      now: () => NOW,
      newWaitId: () => "wait",
    });
    await expect(
      driver.run(channelAdmission(), { ...handle, waitId: "wait" }, new AbortController().signal),
    ).rejects.toThrow();
  });

  test("inline transport preserves a worker run failure identity", async () => {
    const admitted = admit(request, resident, NOW, { maxInlineDepth: 2 });
    if (!admitted.ok) throw admitted.error;
    const driver = createInlineDriver(() => Promise.reject(new WorkerRunError("failed", "run-2")));
    const result = await driver.run(
      admitted,
      {
        delegationId: "d",
        operation: "ask",
        address: request.address,
        transport: "inline",
        deadline: 200,
        rootDelegationId: "d",
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "failed", workerRunId: "run-2" });
  });
});
