import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Bus } from "@openomni/agent";
import { ActorRegistry, SessionHandleStore, Storage, SurfaceKey } from "@openomni/ledger";
import { Gateway } from "@openomni/protocol";
import { messageFixture } from "./helpers/message-fixture";

const directories: string[] = [];
afterEach(() => {
	Storage.reset();
	Bus.reset();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("worker actor send is blocked by a compiled B row before transport", async () => {
	let calls = 0;
	const fixture = messageFixture("worker", {
		deliveryRoutes: new Map([["ws", async () => { calls += 1; return { value: "accepted" as const }; }]]),
		grants: () => [],
	});
	directories.push(fixture.directory);
	const result = await fixture.send({ to: { kind: "actor", actorId: "outside" }, type: "message", content: "hello" });
	expect(result.isError).toBe(true);
	expect(result.output).toContain("message.worker.actor");
	expect(calls).toBe(0);
});

test("new child configuration and first inbox roll back together on an inbox insertion fault", async () => {
	const fixture = messageFixture();
	directories.push(fixture.directory);
	const db = new Database(fixture.dbPath);
	try {
		db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox fault'); END");
		const result = await fixture.send({
			to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
			type: "message", content: "work",
		});
		expect(result.isError).toBe(true);
		expect(SessionHandleStore.listRows().filter((row) => row.role === "worker")).toEqual([]);
		expect(db.query("SELECT count(*) AS count FROM inbox").get()).toEqual({ count: 0 });
	} finally {
		db.close();
	}
});

test("duplicate external event does not commit a second inbox message", async () => {
	const fixture = messageFixture();
	directories.push(fixture.directory);
	const sender = { kind: "external", surface: "ws", externalId: "owner" } as const;
	const facts = { eventId: "same-event", surface: "ws", channelId: "owner", addressees: [], dm: true, payload: {}, render: "hello" };
	const first = await fixture.gateway.ingest(sender, facts);
	const repeated = await fixture.gateway.ingest(sender, facts);
	expect(first.status).toBe("executed");
	expect(repeated).toMatchObject({ status: "blocked_pre", reasonCode: "message.external.event_id_dedupe" });
	if (first.status !== "executed") throw new Error("first message not executed");
	expect(SessionHandleStore.inboxRows(first.handle.target)).toHaveLength(1);
});

test("external ingress retry after inbox fault commits once despite a recorded route", async () => {
	const fixture = messageFixture();
	directories.push(fixture.directory);
	const db = new Database(fixture.dbPath);
	const sender = { kind: "external", surface: "ws", externalId: "owner" } as const;
	const facts = { eventId: "retry", surface: "ws", channelId: "owner", addressees: [], dm: true, payload: {}, render: "hello" };
	try {
		db.exec("CREATE TRIGGER fail_external BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox fault'); END");
		await expect(fixture.gateway.ingest(sender, facts)).rejects.toThrow("inbox fault");
		db.exec("DROP TRIGGER fail_external");
		const result = await fixture.gateway.ingest(sender, facts);
		expect(result.status).toBe("executed");
		if (result.status !== "executed") throw new Error("retry was not committed");
		expect(SessionHandleStore.inboxRows(result.handle.target)).toHaveLength(1);
	} finally { db.close(); }
});

test("conversation correlation cannot select the physical default session", async () => {
	const fixture = messageFixture();
	directories.push(fixture.directory);
	SurfaceKey.claim("ws:unrelated-conversation", fixture.sessionId);
	const result = await fixture.gateway.ingest({ kind: "external", surface: "ws", externalId: "owner" }, {
		eventId: "physical", surface: "ws", channelId: "physical-owner", addressees: [], dm: true,
		reply: { chain: [], externalConversationId: "ws:unrelated-conversation" }, payload: {}, render: "hello",
	});
	expect(result.status).toBe("executed");
	if (result.status !== "executed") throw new Error("message was not committed");
	expect(result.handle.target).not.toBe(fixture.sessionId);
});

test("message observations carry the committed compiled policy rule identity", async () => {
	const fixture = messageFixture("worker");
	directories.push(fixture.directory);
	const observed = Promise.withResolvers<Gateway.MessageObservation>();
	const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => {
		if (event.kind === "message.rejected") observed.resolve(event);
	});
	try {
		await fixture.send({ to: { kind: "actor", actorId: "outside" }, type: "message", content: "hello" });
		expect(await observed.promise).toMatchObject({ kind: "message.rejected", matchedRuleIds: ["message.worker.actor"] });
		expect(SessionHandleStore.tree(fixture.sessionId).some((action) => action.kind === "policy.decision")).toBe(true);
	} finally {
		unsubscribe();
	}
});

test("an actor answer preserves platform correlation and wins its durable message deadline", async () => {
	const fixture = messageFixture("resident", {
		deliveryRoutes: new Map([["ws", async () => ({ value: "accepted" as const, externalMessageId: "platform-reply" })]]),
		grants: () => [{ id: "grant", senderId: "sender", targetActorId: "alice", operations: ["awaited"] }],
		budgets: () => [{ id: "budget", targetActorId: "alice", maxPerWindow: 10, windowMs: 1000, cooldownMs: 0 }],
	});
	directories.push(fixture.directory);
	ActorRegistry.registerIdentity({ id: "alice", kind: "human", trustTier: "owner" });
	ActorRegistry.registerEndpoint({ id: "ws:alice", actorId: "alice", channel: "ws", externalId: "alice" });
	const sent = await fixture.send({
		to: { kind: "actor", actorId: "alice" }, type: "message", content: "question",
		replyTo: "binding", deadline: 200,
	});
	expect(sent.isError).not.toBe(true);
	expect(Storage.get().alarms?.due(199)).toHaveLength(0);
	expect(Storage.get().alarms?.due(200)).toHaveLength(1);
	const reply = await fixture.gateway.ingest(
		{ kind: "external", surface: "ws", externalId: "alice" },
		{
			eventId: "answer", surface: "ws", channelId: "alice", addressees: [], dm: true,
			reply: { replyToMessageId: "platform-reply", chain: ["platform-reply"] },
			payload: {}, render: "answer"
		},
	);
	expect(reply.status).toBe("executed");
	expect(SessionHandleStore.inboxRows(fixture.sessionId).at(-1)?.origin.value).toMatchObject({ kind: "external_reply" });
	expect(SessionHandleStore.expireMessageDeadlines(200)).toEqual([]);
});
