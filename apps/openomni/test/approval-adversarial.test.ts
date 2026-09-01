import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ActorRegistry, ApprovalStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  approvalDecideToolExecutor,
  type ApprovalPort,
  approvalRequestToolExecutor,
  contactPromoteToolExecutor,
  endpointMergeToolExecutor,
} from "../src/tools/approval";
import { catalogEntries } from "../src/tools/catalog";

/**
 * Adversarial cases from docs/conversation-and-message-io.md against the
 * REAL stores: §8.4 (cross-channel identity spoofing — merging is an
 * Owner-approval act, never inferred), §8.12 (a provisional contact holds
 * no authority until promoted), §8.13 (approval fatigue — requests are
 * volume-bounded and the timeout default is refusal).
 */

const port: ApprovalPort = {
  request: ApprovalStore.request,
  get: ApprovalStore.get,
  decide: ApprovalStore.decide,
  decision: ApprovalStore.decision,
  getIdentity: ActorRegistry.getIdentity,
  getEndpoint: ActorRegistry.getEndpoint,
  promote: ActorRegistry.promote,
  mergeEndpoint: ActorRegistry.mergeEndpoint,
};

const T0 = 1_000;
const TIMEOUT = 60_000;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ActorRegistry.mintProvisional(
    {
      id: "contact:whatsapp:mallory",
      kind: "unknown",
      trustTier: "observer",
      standing: "provisional",
    },
    { id: "ep:whatsapp:mallory", channel: "whatsapp", externalId: "mallory-wa" },
  );
  ActorRegistry.registerIdentity({ id: "actor:alice", kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: "ep:slack:alice",
    actorId: "actor:alice",
    channel: "slack",
    externalId: "alice-slack",
  });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

function approvalIdFrom(text: string): string {
  const match = /approval (approval:[0-9a-f-]+) pending/.exec(text);
  if (!match?.[1]) throw new Error(`no approval id in: ${text}`);
  return match[1];
}

async function requestPromotion(at = T0): Promise<string> {
  const text = await approvalRequestToolExecutor(port, () => at)({
    act: "contact_promotion",
    actorId: "contact:whatsapp:mallory",
    timeoutMs: TIMEOUT,
  });
  return approvalIdFrom(text);
}

describe("§8.13 — the approval lane fails closed", () => {
  it("an unanswered request refuses the act after its deadline", async () => {
    const approvalId = await requestPromotion();

    const early = await contactPromoteToolExecutor(port, () => T0 + 1)({ approvalId });
    expect(early).toContain("is pending");

    const late = await contactPromoteToolExecutor(port, () => T0 + TIMEOUT)({ approvalId });
    expect(late).toContain("is refused");
    expect(ActorRegistry.getIdentity("contact:whatsapp:mallory")?.standing).toBe("provisional");
  });

  it("the Owner cannot approve into the past — a late answer records the deadline's refusal", async () => {
    const approvalId = await requestPromotion();

    const text = await approvalDecideToolExecutor(port, () => T0 + TIMEOUT + 1)({
      approvalId,
      decision: "approved",
    });

    expect(text).toContain("refused by deadline");
  });

  it("a request storm hits the volume bound instead of burying the Owner", async () => {
    const run = approvalRequestToolExecutor(port, () => T0);
    for (let i = 0; i < 8; i += 1) {
      expect(
        await run({ act: "endpoint_merge", endpointId: "ep:whatsapp:mallory", toActorId: "actor:alice", timeoutMs: TIMEOUT }),
      ).toContain("pending");
    }

    const ninth = await run({
      act: "endpoint_merge",
      endpointId: "ep:whatsapp:mallory",
      toActorId: "actor:alice",
      timeoutMs: TIMEOUT,
    });

    expect(ninth).toContain("approval_request refused:");
    expect(ninth).toContain("pending requests already opened");
  });
});

describe("§8.12 — a provisional contact holds no authority until promoted", () => {
  it("promotion executes only with the Owner's recorded approval", async () => {
    const approvalId = await requestPromotion();
    await approvalDecideToolExecutor(port, () => T0 + 1)({ approvalId, decision: "approved" });

    const text = await contactPromoteToolExecutor(port, () => T0 + 2)({ approvalId });

    expect(text).toContain("contact contact:whatsapp:mallory registered");
    expect(ActorRegistry.getIdentity("contact:whatsapp:mallory")?.standing).toBe("registered");
  });

  it("a refused approval never promotes", async () => {
    const approvalId = await requestPromotion();
    await approvalDecideToolExecutor(port, () => T0 + 1)({ approvalId, decision: "refused" });

    const text = await contactPromoteToolExecutor(port, () => T0 + 2)({ approvalId });

    expect(text).toContain("is refused");
    expect(ActorRegistry.getIdentity("contact:whatsapp:mallory")?.standing).toBe("provisional");
  });

  it("requesting promotion of a registered or missing contact refuses upfront", async () => {
    const run = approvalRequestToolExecutor(port, () => T0);
    expect(await run({ act: "contact_promotion", actorId: "actor:alice", timeoutMs: TIMEOUT })).toContain(
      "already registered",
    );
    expect(await run({ act: "contact_promotion", actorId: "ghost", timeoutMs: TIMEOUT })).toContain(
      "does not exist",
    );
  });
});

describe("§8.4 — cross-channel merging is an explicit Owner act", () => {
  async function requestMerge(at = T0): Promise<string> {
    const text = await approvalRequestToolExecutor(port, () => at)({
      act: "endpoint_merge",
      endpointId: "ep:whatsapp:mallory",
      toActorId: "actor:alice",
      timeoutMs: TIMEOUT,
    });
    return approvalIdFrom(text);
  }

  it("identity stays per-endpoint: the same human on two channels is two contacts until merged", () => {
    expect(ActorRegistry.resolveEndpoint("whatsapp", "mallory-wa")?.identity.id).toBe(
      "contact:whatsapp:mallory",
    );
    expect(ActorRegistry.resolveEndpoint("slack", "alice-slack")?.identity.id).toBe("actor:alice");
  });

  it("a merge lands only with the Owner's approval and moves exactly the approved endpoint", async () => {
    const approvalId = await requestMerge();

    const unapproved = await endpointMergeToolExecutor(port, () => T0 + 1)({ approvalId });
    expect(unapproved).toContain("is pending");

    await approvalDecideToolExecutor(port, () => T0 + 1)({ approvalId, decision: "approved" });
    const text = await endpointMergeToolExecutor(port, () => T0 + 2)({ approvalId });

    expect(text).toContain("merged into actor:alice");
    expect(ActorRegistry.resolveEndpoint("whatsapp", "mallory-wa")?.identity.id).toBe(
      "actor:alice",
    );
  });

  it("an approval for one act never authorizes the other", async () => {
    const approvalId = await requestPromotion();
    await approvalDecideToolExecutor(port, () => T0 + 1)({ approvalId, decision: "approved" });

    const text = await endpointMergeToolExecutor(port, () => T0 + 2)({ approvalId });

    expect(text).toContain("approves a contact_promotion, not a endpoint_merge");
  });

  it("a merge whose endpoint changed hands since the request refuses (anti-TOCTOU)", async () => {
    const approvalId = await requestMerge();
    await approvalDecideToolExecutor(port, () => T0 + 1)({ approvalId, decision: "approved" });
    // The endpoint moves elsewhere between request and act.
    ActorRegistry.registerIdentity({ id: "actor:bob", kind: "human", trustTier: "collaborator" });
    ActorRegistry.mergeEndpoint("ep:whatsapp:mallory", "actor:bob");

    const text = await endpointMergeToolExecutor(port, () => T0 + 2)({ approvalId });

    expect(text).toContain("no longer belongs to contact:whatsapp:mallory");
    expect(ActorRegistry.resolveEndpoint("whatsapp", "mallory-wa")?.identity.id).toBe("actor:bob");
  });
});

describe("catalog gate — the approval lane is the Resident's alone", () => {
  it("workers see none of the approval tools", () => {
    const ports = { approvals: port };
    const resident = catalogEntries(ports, { role: "resident", depth: 0, sessionId: "s" });
    const worker = catalogEntries(ports, { role: "worker", depth: 1, sessionId: "s" });
    const approvalTools = ["approval_request", "approval_decide", "contact_promote", "endpoint_merge"];

    expect(resident.map((entry) => entry.spec.name)).toEqual(expect.arrayContaining(approvalTools));
    const workerNames = worker.map((entry) => entry.spec.name);
    for (const name of approvalTools) {
      expect(workerNames).not.toContain(name);
    }
  });
});
