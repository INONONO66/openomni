import { beforeEach, expect, test } from "bun:test";
import { WaitStore } from "@openomni/ledger";
import {
  commits,
  createMappedOwnerSession,
  kernelRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

test("inbox receipt target equals the durable route decision", async () => {
  const mapped = createMappedOwnerSession();
  const result = await kernelRouter().ingest(ownerSender, ownerFacts);
  expect(result).toMatchObject({
    status: "executed",
    handle: { target: mapped.id },
    delivery: { kind: "session" },
  });
  expect(routingDecisions()[0]).toMatchObject({
    sessionId: mapped.id,
    actorId: "actor-owner",
    trustTier: "owner",
  });
  expect(commits[0]).toMatchObject({
    sessionId: mapped.id,
    origin: { value: { kind: "external", actorId: "actor-owner" } },
  });
});

test("Wait correlation selects the owner inbox instead of the default session", async () => {
  const mapped = createMappedOwnerSession();
  WaitStore.create(
    {
      id: "wait-contract",
      ownerRef: { kind: "session", id: "wait-owner" },
      originMessageId: "outbound",
      correlation: { tokenHash: "token", channelId: ownerFacts.channelId },
      allowedActions: ["report_result"],
      expectedResponders: ["actor-owner"],
      resolutionPolicy: "first_reply",
      expiresAt: Number.MAX_SAFE_INTEGER,
      followUpWindow: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    "trace",
  );
  const result = await kernelRouter().ingest(ownerSender, {
    ...ownerFacts,
    reply: { chain: [], tokenHash: "token" },
    payload: { action: "report_result", output: "done" },
    render: "done",
  });
  expect(result).toMatchObject({ status: "executed", handle: { target: "wait-owner" } });
  expect(commits[0]?.sessionId).not.toBe(mapped.id);
  expect(routingDecisions()[0]).toMatchObject({
    stage: "wait_correlation",
    sessionId: "wait-owner",
  });
  expect(WaitStore.get("wait-contract")?.status).toBe("resolved");
});
