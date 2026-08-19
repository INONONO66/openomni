import { describe, expect, test } from "bun:test";
import { Engagement, type Tool } from "@openomni/protocol";
import { createEngagementTools, type EngagementPort } from "./engagement.js";

const NOW = 1_700_000_000_000;

const context = {
  traceContext: { traceId: "trace-engagement", sessionId: "ses-owner", runId: "run-1" },
} as const;

function makePort(): { port: EngagementPort; records: Map<string, Engagement.Record> } {
  const records = new Map<string, Engagement.Record>();
  const port: EngagementPort = {
    open(input, _traceId, at = NOW) {
      const record = Engagement.open(input, at);
      records.set(record.id, record);
      return record;
    },
    transition(id, input, _traceId) {
      const current = records.get(id);
      if (current === undefined) throw new Error(`not found: ${id}`);
      const outcome = Engagement.transition(current, input);
      if (outcome.kind !== "rejected") records.set(id, outcome.record);
      return outcome;
    },
    get(id) {
      return records.get(id);
    },
    list(filter) {
      return [...records.values()].filter(
        (record) =>
          (filter?.ownerSessionId === undefined ||
            record.ownerSessionId === filter.ownerSessionId) &&
          (filter?.states === undefined || filter.states.includes(record.state)),
      );
    },
    activeStates: [
      "planning",
      "awaiting_external",
      "deliberating",
      "awaiting_user_approval",
      "acting",
    ],
  };
  return { port, records };
}

function makeTools(port: EngagementPort) {
  const tools = createEngagementTools({ engagements: port, now: () => NOW });
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const get = (name: string) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool;
  };
  return {
    open: get("engagement.open"),
    transition: get("engagement.transition"),
    list: get("engagement.list"),
  };
}

function call(tool: string, input: Record<string, unknown>): Tool.Call {
  return { id: "call-1", tool, input };
}

async function openOne(
  tools: ReturnType<typeof makeTools>,
  terms: Record<string, unknown> = {},
): Promise<string> {
  const result = await tools.open.execute(
    call("engagement.open", {
      title: "sell bike, floor 50000",
      terms,
      sessionId: "ses-owner",
    }),
    context,
  );
  expect(result.isError).toBeUndefined();
  return (JSON.parse(result.output) as { id: string }).id;
}

describe("engagement tools posture", () => {
  test("delegation category, implicit inputs, public schemas strip the injected slots", () => {
    const { port } = makePort();
    const { open, transition, list } = makeTools(port);
    for (const tool of [open, transition, list]) {
      expect(tool.category).toBe("delegation");
      const properties = (tool.spec.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(properties.sessionId).toBeUndefined();
      expect(properties.actorTrustTier).toBeUndefined();
    }
    expect(open.implicitInputs).toEqual({ sessionId: "sessionId" });
    expect(transition.implicitInputs).toEqual({
      sessionId: "sessionId",
      actorTrustTier: "actorTrustTier",
    });
    expect(list.implicitInputs).toEqual({ sessionId: "sessionId" });
    expect(list.isReadOnly).toBe(true);
  });
});

describe("engagement.open", () => {
  test("opens in planning for the calling session and records the terms verbatim", async () => {
    const { port, records } = makePort();
    const tools = makeTools(port);
    const id = await openOne(tools, { spendCeiling: 50_000, autoApprove: "50000원 이상 제시" });
    const record = records.get(id);
    expect(record?.state).toBe("planning");
    expect(record?.ownerSessionId).toBe("ses-owner");
    expect(record?.terms).toEqual({ spendCeiling: 50_000, autoApprove: "50000원 이상 제시" });
  });

  test("refuses without the injected session context", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const result = await tools.open.execute(
      call("engagement.open", { title: "sell bike" }),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("calling session context");
  });
});

describe("engagement.transition — the approval gate", () => {
  async function toAwaitingApproval(tools: ReturnType<typeof makeTools>): Promise<string> {
    const id = await openOne(tools);
    for (const to of ["deliberating", "awaiting_user_approval"]) {
      const result = await tools.transition.execute(
        call("engagement.transition", { id, to, reason: "advance", sessionId: "ses-owner" }),
        context,
      );
      expect(JSON.parse(result.output).kind).toBe("transitioned");
    }
    return id;
  }

  test("acting is refused when the triggering delivery has no owner-tier verdict", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const id = await toAwaitingApproval(tools);
    for (const tier of [undefined, "collaborator", "observer", "manager", "assigned_worker"]) {
      const result = await tools.transition.execute(
        call("engagement.transition", {
          id,
          to: "acting",
          reason: "go",
          sessionId: "ses-owner",
          ...(tier === undefined ? {} : { actorTrustTier: tier }),
        }),
        context,
      );
      expect(JSON.parse(result.output)).toMatchObject({
        kind: "rejected",
        code: "approval_required",
      });
    }
  });

  test("acting proceeds when the delivery's trust tier is owner or co_owner", async () => {
    for (const tier of ["owner", "co_owner"]) {
      const { port } = makePort();
      const tools = makeTools(port);
      const id = await toAwaitingApproval(tools);
      const result = await tools.transition.execute(
        call("engagement.transition", {
          id,
          to: "acting",
          reason: "owner said yes in-channel",
          sessionId: "ses-owner",
          actorTrustTier: tier,
        }),
        context,
      );
      expect(JSON.parse(result.output)).toMatchObject({ kind: "transitioned", to: "acting" });
    }
  });

  test("a reported term crossing forces awaiting_user_approval", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const id = await openOne(tools, { spendCeiling: 50_000 });
    await tools.transition.execute(
      call("engagement.transition", {
        id,
        to: "deliberating",
        reason: "reply arrived",
        sessionId: "ses-owner",
      }),
      context,
    );
    const result = await tools.transition.execute(
      call("engagement.transition", {
        id,
        to: "acting",
        reason: "buyer offers 45000 — below floor",
        termCrossed: true,
        sessionId: "ses-owner",
        actorTrustTier: "owner",
      }),
      context,
    );
    expect(JSON.parse(result.output)).toMatchObject({
      kind: "forced_approval",
      requested: "acting",
    });
    expect(port.get(id)?.state).toBe("awaiting_user_approval");
  });

  test("illegal edges come back as typed rejected results", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const id = await openOne(tools);
    const result = await tools.transition.execute(
      call("engagement.transition", {
        id,
        to: "done",
        reason: "skip ahead",
        sessionId: "ses-owner",
      }),
      context,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({
      kind: "rejected",
      code: "illegal_transition",
    });
  });

  test("cross-session transitions are refused (owner-session only)", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const id = await openOne(tools);
    const result = await tools.transition.execute(
      call("engagement.transition", {
        id,
        to: "deliberating",
        reason: "hijack",
        sessionId: "ses-intruder",
        actorTrustTier: "owner",
      }),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("belongs to another session");
  });
});

describe("engagement.list", () => {
  test("lists only the calling session's active engagements", async () => {
    const { port } = makePort();
    const tools = makeTools(port);
    const id = await openOne(tools);
    port.open(
      { id: "eng-other", ownerSessionId: "ses-other", title: "other", terms: {} },
      "trace",
      NOW,
    );
    const result = await tools.list.execute(
      call("engagement.list", { sessionId: "ses-owner" }),
      context,
    );
    const listed = JSON.parse(result.output) as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual([id]);
  });
});
