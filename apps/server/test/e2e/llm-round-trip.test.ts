import { beforeEach, describe, expect, test } from "bun:test";
import {
  ActorRegistry,
  ChannelGrantStore,
  EngagementStore,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import type { Gateway } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { composeHarness } from "./harness";
import { proxyModel, stubModel } from "./model-seam";

/**
 * Swappable-model E2E: one inbound event travels the REAL router →
 * Gateway.Deliver → REAL brain deliver → REAL resident run (production
 * toolExecutorFactory) → reply, with the model behind a seam. The stub proves
 * the wiring deterministically; the same harness becomes a live test the
 * moment a proxy baseURL/auth is present.
 *
 * The only fakes: the outbound platform delivery route (capturing) and the
 * model (stub, one-line swap to `proxyModel()`).
 */

const OWNER = "actor-owner";
const OWNER_ENDPOINT = "telegram:owner-1";
const OWNER_CHANNEL = "telegram:owner-dm";
const COLLAB = "actor-collab";
const COLLAB_ENDPOINT = "telegram:collab-1";
const COLLAB_CHANNEL = "telegram:collab-dm";
const SELLER = "actor-seller";
const SELLER_ENDPOINT = "telegram:seller-1";
const PERSONA = "actor-persona";

function registerActors(): void {
  ActorRegistry.registerIdentity({ id: PERSONA, kind: "ai_agent", trustTier: "owner" });
  ActorRegistry.registerIdentity({ id: OWNER, kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({
    id: OWNER_ENDPOINT,
    actorId: OWNER,
    channel: "telegram",
    externalId: "owner-1",
  });
  // A collaborator on the evidence tier: admitted enough to be heard, never to
  // drive tool use.
  ActorRegistry.registerIdentity({ id: COLLAB, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: COLLAB_ENDPOINT,
    actorId: COLLAB,
    channel: "telegram",
    externalId: "collab-1",
  });
  ActorRegistry.registerIdentity({ id: SELLER, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: SELLER_ENDPOINT,
    actorId: SELLER,
    channel: "telegram",
    externalId: "seller-1",
  });
  // The Owner's DM is a trusted channel (full access); the collaborator's DM is
  // trusted-but-evidence-only (§2a) — the S6 gate reads its treatment.
  ChannelGrantStore.put({
    id: "grant-owner-dm",
    surface: "telegram",
    channel: OWNER_CHANNEL,
    kind: "trusted_channel",
    inboundTreatment: "full_access",
    createdBy: OWNER,
  });
  ChannelGrantStore.put({
    id: "grant-collab-dm",
    surface: "telegram",
    channel: COLLAB_CHANNEL,
    kind: "trusted_channel",
    inboundTreatment: "evidence_only",
    createdBy: OWNER,
  });
}

function ownerInbound(id: string, text: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace-${id}`,
    surface: "telegram",
    channel: OWNER_CHANNEL,
    userId: "owner-1",
    mode: "direct",
    payload: text,
    meta: {},
  };
}

function collabInbound(id: string, text: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace-${id}`,
    surface: "telegram",
    channel: COLLAB_CHANNEL,
    userId: "collab-1",
    mode: "direct",
    payload: text,
    meta: {},
  };
}

function sellerReply(id: string, replyToMessageId: string, output: string): Gateway.DeliveredEvent {
  return {
    id,
    traceId: `trace-${id}`,
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload: { action: "report_result", output },
    meta: {
      correlation: {
        endpointId: SELLER_ENDPOINT,
        channelId: "telegram:dm",
        replyToMessageId,
      },
    },
  };
}

function probeCall(): { id: string; tool: string; input: Record<string, unknown> } {
  return { id: crypto.randomUUID(), tool: "probe", input: {} };
}

describe("swappable-model E2E round trip (stub mode)", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    registerActors();
  });

  // ---- Case 1: reactive reply -------------------------------------------
  test("owner DM → full_access → resident run → assistant text on the same surface", async () => {
    const model = stubModel();
    model.scripts.push({ text: "현재 상태: 정상 가동 중입니다." });
    const harness = composeHarness({ model });

    const result = await harness.router.ingest(ownerInbound("inbound-status", "현재 상태 알려줘"));

    if (result.kind === "dropped") throw new Error("owner DM was dropped");
    // The round trip returned the resident's reply on the owner's surface.
    expect(result.result.output).toBe("현재 상태: 정상 가동 중입니다.");
    // The perimeter admitted the owner at full access and threaded the verdict.
    expect(harness.deliveries[0]?.actorContext?.trustTier).toBe("owner");
    expect(harness.deliveries[0]?.actorContext?.inboundTreatment).toBe("full_access");
    expect(harness.factoryContexts[0]).toEqual({ actorTrustTier: "owner" });
  });

  // ---- Case 2: evidence_only deny vs owner allow ------------------------
  test("evidence_only run denies a scripted tool call that the owner run allows (S6 gate)", async () => {
    const model = stubModel();
    // Turn 1 (owner, full_access): the probe is allowed and executes for real.
    model.scripts.push({ text: "probe done", toolCalls: [probeCall()] });
    // Turn 2 (collaborator, evidence_only): the SAME probe is denied fail-closed.
    model.scripts.push({ text: "noted (evidence only)", toolCalls: [probeCall()] });
    const harness = composeHarness({ model });

    const owner = await harness.router.ingest(ownerInbound("inbound-owner-probe", "probe please"));
    if (owner.kind === "dropped") throw new Error("owner probe was dropped");
    const evidence = await harness.router.ingest(
      collabInbound("inbound-collab-probe", "run the probe"),
    );
    if (evidence.kind === "dropped") throw new Error("collaborator inbound was dropped");

    // Perimeter treatments reached the runs verbatim.
    expect(harness.deliveries[0]?.actorContext?.inboundTreatment).toBe("full_access");
    expect(harness.deliveries[1]?.actorContext?.inboundTreatment).toBe("evidence_only");

    // Owner turn: the real gated executor allowed the call → production probe ran.
    const ownerResult = model.llmCaptures[0]?.toolResults[0];
    expect(ownerResult?.isError).toBeFalsy();
    expect(ownerResult?.output).toContain('"probe":"ok"');

    // Evidence turn: deny-all overrode the allow permission → typed denial,
    // the production tool never ran.
    const evidenceResult = model.llmCaptures[1]?.toolResults[0];
    expect(evidenceResult?.isError).toBe(true);
    expect(evidenceResult?.output).toContain("Denied");
    expect(evidenceResult?.output).not.toContain('"probe":"ok"');
  });

  // ---- Case 3: engagement state hydrated into the run context -----------
  test("an owner query hydrates the session's engagement slice into the prompt the model sees", async () => {
    const model = stubModel();
    model.scripts.push({ text: "안녕하세요" }); // Run 1 materializes the session.
    model.scripts.push({ text: "협상 진행 중입니다" }); // Run 2 sees the engagement slice.
    const harness = composeHarness({ model });

    const first = await harness.router.ingest(ownerInbound("inbound-open", "안녕"));
    if (first.kind === "dropped") throw new Error("first owner DM was dropped");
    const ownerSessionId = first.sessionId;
    if (ownerSessionId === undefined) throw new Error("owner session was not materialized");

    const deadline = Date.now() + 3_600_000;
    EngagementStore.open(
      {
        id: "eng-negotiation",
        ownerSessionId,
        title: "중고 거래 협상",
        terms: { deadline },
      },
      "trace-seed-engagement",
    );

    const second = await harness.router.ingest(ownerInbound("inbound-query", "협상 상태 알려줘"));
    if (second.kind === "dropped") throw new Error("owner query was dropped");

    // The engagement slice prepends as a machine-side context block the model saw.
    const hydrated = model.runInputs[1]?.messages[0];
    expect(hydrated?.role).toBe("user");
    expect(hydrated?.partMetadata).toEqual({ engagementContext: true });
    expect(hydrated?.content).toContain("[engagement context");
    expect(hydrated?.content).toContain("중고 거래 협상");
    expect(hydrated?.content).toContain(new Date(deadline).toISOString());
    // The first run — before any engagement existed — saw no slice.
    expect(
      model.runInputs[0]?.messages.some((m) => m.content.includes("[engagement context")),
    ).toBe(false);
  });

  // ---- Case 4: awaited as-me send → reply resumes the calling session ----
  test("an awaited as-me send opens a Wait and the responder's reply resumes the run with waitContext", async () => {
    const model = stubModel();
    // Run 1 (owner): the resident sends an awaited as-me message to the seller.
    model.scripts.push({
      text: "판매자에게 문의를 보냈습니다.",
      toolCalls: [
        {
          id: crypto.randomUUID(),
          tool: "message.send",
          input: {
            target: { actorId: SELLER },
            body: "still available? 5만원에 가능할까요?",
            operation: "awaited",
            expectReply: { expiresInMs: 3_600_000 },
          },
        },
      ],
    });
    // Run 2 (wait resumption): the reply comes back and the resident acknowledges.
    model.scripts.push({ text: "판매자가 확인해줬습니다." });

    const harness = composeHarness({
      model,
      grants: [
        {
          id: "grant-persona-seller",
          senderId: PERSONA,
          targetActorId: SELLER,
          operations: ["awaited", "fire_and_forget"],
        },
      ],
    });

    const opened = await harness.router.ingest(ownerInbound("inbound-send", "판매자한테 물어봐줘"));
    if (opened.kind === "dropped") throw new Error("owner send request was dropped");

    // The as-me send was delivered to the platform and opened a durable wait.
    const sent = JSON.parse(model.llmCaptures[0]?.toolResults[0]?.output ?? "{}") as {
      kind?: string;
      waitId?: string;
    };
    expect(sent.kind).toBe("sent");
    const waitId = sent.waitId;
    if (waitId === undefined) throw new Error("send did not open a wait");
    expect(harness.outbound).toEqual([
      { externalId: "seller-1", body: "still available? 5만원에 가능할까요?" },
    ]);
    expect(WaitStore.get(waitId)).toMatchObject({
      status: "open",
      ownerRef: { kind: "session", id: opened.sessionId },
      expectedResponders: [SELLER],
    });

    // The responder's reply correlates through the router and resumes the run.
    const resumed = await harness.router.ingest(
      sellerReply("inbound-seller-reply", "platform:1", "네, 가능합니다"),
    );
    if (resumed.kind === "dropped") throw new Error("seller reply was dropped");
    expect(resumed.sessionId).toBe(opened.sessionId);
    expect(resumed.result.output).toBe("판매자가 확인해줬습니다.");
    expect(WaitStore.get(waitId)).toMatchObject({ status: "resolved" });
    const resumeDelivery = harness.deliveries.at(-1);
    expect(resumeDelivery?.waitContext).toMatchObject({ waitId, allowedAction: "report_result" });
    expect(resumeDelivery?.sessionId).toBe(opened.sessionId);
  });
});

// ---- Live mode: skipped cleanly unless a proxy is configured -------------
describe("live proxy mode", () => {
  const proxy = proxyModel();

  test.skipIf(!proxy.configured)("owner DM round trips through the real proxy model", async () => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    registerActors();
    const harness = composeHarness({ model: proxy });
    const result = await harness.router.ingest(
      ownerInbound("inbound-live", "Say the single word: online."),
    );
    if (result.kind === "dropped") throw new Error("live owner DM was dropped");
    expect(result.result.output.length).toBeGreaterThan(0);
  });

  test("proxy seam contract: no injection, and it reports whether live mode is enabled", () => {
    if (!proxy.configured) {
      // Never a fake pass: the live round trip above is genuinely skipped.
      // Print exactly how to enable it.
      console.log(
        "[e2e] live LLM not configured — skipping the proxy round trip. To run it live, set " +
          "OPENOMNI_E2E_PROXY_URL (+ optional OPENOMNI_E2E_PROXY_KEY / OPENOMNI_E2E_PROXY_PROVIDER / " +
          "OPENOMNI_E2E_PROXY_MODEL), or point OPENOMNI_AUTH_FILE at a proxy auth.json. Would run: " +
          `${proxy.model.provider}/${proxy.model.id}.`,
      );
    }
    // The proxy model injects NOTHING — it uses the runtime's real default path.
    expect(proxy.residentOptions().runAgent).toBeUndefined();
    expect(proxy.model.provider).toBeTruthy();
    expect(proxy.model.id).toBeTruthy();
  });
});
