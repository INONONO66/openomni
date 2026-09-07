import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Bus } from "@openomni/agent";
import {
  ActorRegistry,
  EgressBudgetStore,
  SessionHandleStore,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Gateway, L0Observation } from "@openomni/protocol";
import { messageFixture } from "./helpers/message-fixture";
import { z } from "zod";

const directories: string[] = [];
afterEach(() => {
  Storage.reset();
  Bus.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function registerPeer() {
  ActorRegistry.registerIdentity({ id: "peer", kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({
    id: "ws:peer",
    actorId: "peer",
    channel: "ws",
    externalId: "peer",
  });
}
const sender = { kind: "external", surface: "ws", externalId: "peer" } as const;
const facts = {
  eventId: "answer",
  surface: "ws",
  channelId: "peer",
  dm: true,
  addressees: [],
  payload: {},
  render: "ANSWER",
};

for (const mode of ["ancestor", "nearer", "ambiguous"] as const) {
  test(`complete reply chain selects ${mode} through the compiled gateway`, async () => {
    let sequence = 0;
    const fixture = messageFixture("resident", {
      deliveryRoutes: new Map([
        [
          "ws",
          async () => ({
            value: "accepted" as const,
            externalMessageId: `platform-${mode === "ambiguous" ? 1 : ++sequence}`,
          }),
        ],
      ]),
      grants: () => [
        { id: "grant", senderId: "sender", targetActorId: "peer", operations: ["awaited"] },
      ],
      budgets: () => [
        { id: "budget", targetActorId: "peer", maxPerWindow: 20, windowMs: 1000, cooldownMs: 0 },
      ],
    });
    directories.push(fixture.directory);
    registerPeer();
    for (let index = 0; index < 2; index++)
      expect(
        (
          await fixture.send({
            to: { kind: "actor", actorId: "peer" },
            type: "message",
            content: `Q${index}`,
            deadline: 1000,
          })
        ).isError,
      ).not.toBe(true);
    const receipt = await fixture.gateway.ingest(sender, {
      ...facts,
      reply: {
        replyToMessageId: "unrelated-immediate",
        chain: ["unrelated-immediate", ...(mode === "nearer" ? ["platform-2"] : []), "platform-1"],
      },
    });
    if (mode === "ambiguous") {
      expect(receipt.status).toBe("blocked_pre");
      expect(SessionHandleStore.inboxRows("sender")).toEqual([]);
      return;
    }
    expect(receipt).toMatchObject({ status: "executed", handle: { target: "sender" } });
    expect(SessionHandleStore.inboxRows("sender").at(-1)?.content).toBe("ANSWER");
    const resolved = WaitStore.list().filter((wait) => wait.status === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.correlation.replyToMessageId).toBe(
      mode === "nearer" ? "platform-2" : "platform-1",
    );
  });
}

test("child admission observations see the inbox and deadline together on another connection", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  using db = new Database(fixture.dbPath, { readonly: true });
  const visible: Array<{ inbox: number; alarm: number }> = [];
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "prompt" && event.kind !== "alarm.arm") return;
    visible.push({
      inbox: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox").get()?.n ?? 0,
      alarm: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM alarm").get()?.n ?? 0,
    });
  });
  try {
    expect(
      (
        await fixture.send({
          to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
          type: "message",
          content: "work",
          deadline: 200,
        })
      ).isError,
    ).not.toBe(true);
    expect(visible).toEqual([
      { inbox: 1, alarm: 1 },
      { inbox: 1, alarm: 1 },
    ]);
  } finally {
    unsubscribe();
  }
});

test("alarm insertion failure rolls back the child, configuration, inbox and alarm action", async () => {
  const fixture = messageFixture();
  directories.push(fixture.directory);
  using db = new Database(fixture.dbPath);
  db.exec(
    "CREATE TRIGGER fail_alarm BEFORE INSERT ON alarm BEGIN SELECT RAISE(ABORT, 'alarm fault'); END",
  );
  const receipt = await fixture.send({
    to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
    type: "message",
    content: "LOST_DEADLINE",
    deadline: 200,
  });
  expect(receipt.isError).toBe(true);
  expect(SessionHandleStore.listRows().filter((row) => row.role === "worker")).toEqual([]);
  expect(db.query("SELECT id FROM alarm").all()).toEqual([]);
  expect(db.query("SELECT id FROM inbox").all()).toEqual([]);
  expect(SessionHandleStore.tree("sender").filter((action) => action.kind === "alarm.arm")).toEqual(
    [],
  );
});

test("process loss between inbox and alarm insertion exposes neither after reopen", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("./fixtures/message-admission-crash.ts", import.meta.url).pathname],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(86);
  const fixture = z.object({ directory: z.string(), dbPath: z.string() }).parse(JSON.parse(stdout));
  directories.push(fixture.directory);
  Storage.initialize({ dbPath: fixture.dbPath });
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["gateway-ingress", "sender"]);
  expect(SessionHandleStore.inboxRows("sender")).toEqual([]);
  expect(SessionHandleStore.tree("sender").filter((action) => action.kind === "alarm.arm")).toEqual(
    [],
  );
  using db = new Database(fixture.dbPath);
  expect(db.query("SELECT id FROM inbox").all()).toEqual([]);
  expect(db.query("SELECT id FROM alarm").all()).toEqual([]);
});

for (const restriction of ["dnc", "zero", "spent", "allowed"] as const) {
  test(`Table A projects live ${restriction} budget without debiting ingress`, async () => {
    let reads = 0;
    const fixture = messageFixture("resident", {
      deliveryRoutes: new Map(),
      grants: () => [],
      budgets: () => {
        reads += 1;
        return [
          {
            id: "budget",
            targetActorId: "peer",
            maxPerWindow: restriction === "zero" ? 0 : 1,
            windowMs: 1000,
            cooldownMs: 0,
            doNotContact: restriction === "dnc",
          },
        ];
      },
    });
    directories.push(fixture.directory);
    registerPeer();
    const observations: Gateway.MessageObservation[] = [];
    const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => observations.push(event));
    try {
      const initial = await fixture.gateway.ingest(sender, { ...facts, eventId: "first" });
      let receipt = initial;
      if (restriction === "spent") {
        if (initial.status !== "executed") throw new Error("initial admission refused");
        EgressBudgetStore.claim(
          {
            id: "spent",
            senderId: initial.handle.target,
            targetActorId: "peer",
            class: "converse",
            at: 100,
          },
          0,
          () => "allow",
        );
        receipt = await fixture.gateway.ingest(sender, { ...facts, eventId: "second" });
      }
      expect(reads).toBeGreaterThan(0);
      expect(receipt.status).toBe(restriction === "allowed" ? "executed" : "blocked_pre");
      if (restriction !== "allowed")
        expect(observations).toContainEqual(
          expect.objectContaining({
            kind: "message.rejected",
            matchedRuleIds: ["message.external.egress_budget"],
          }),
        );
      using db = new Database(fixture.dbPath);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM egress_debit").get()?.count,
      ).toBe(restriction === "spent" ? 1 : 0);
    } finally {
      unsubscribe();
    }
  });
}
