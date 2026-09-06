import { expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { Gateway } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test.each(["?actor=owner", ""])("startOpenOmni delivers the final response through an actor send for connection %s", async (query) => {
	const app = await suite.boot({
		config: suite.config("message-e2e-", { wsToken: "token" }),
		llm: {
			resolveModel: fakeProviderModel,
			run: async (input, sink) => {
				sink.onMessage(assistantMessage(input, { text: "FINAL_SENTINEL" }));
				return { type: "stop" };
			},
		},
	});
	const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws${query}`, ["auth", "token"]);
	const receipt = nextFrame(ws, (frame) => frame.type === "receipt");
	const final = nextFrame(ws, (frame) => frame.type === "message");
	ws.send(JSON.stringify({ text: "start" }));
	expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
	expect(await final).toMatchObject({ type: "message", text: "FINAL_SENTINEL" });
	const actions = SessionHandleStore.listRows().flatMap((row) => SessionHandleStore.tree(row.id));
	expect(actions.some((action) => action.kind === "message")).toBe(true);
});

test("a child session terminal commits exactly one parent reply with the original reply binding", async () => {
	let commissioned = false;
	const reply = Promise.withResolvers<void>();
	const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => {
		if (event.kind === "message.replied") reply.resolve();
	});
	suite.defer(unsubscribe);
	const app = await suite.boot({
		config: suite.config("message-child-", { wsToken: "token" }),
		llm: {
			resolveModel: fakeProviderModel,
			run: async (input, sink) => {
				if (SessionHandleStore.row(input.trace.sessionId).role === "worker") {
					sink.onMessage(assistantMessage(input, { text: "CHILD_SENTINEL" }));
					return { type: "stop" };
				}
				if (!commissioned) {
					const output = requestToolStep(input, sink, {
						id: "commission", tool: "sendMessage",
						input: {
							to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
							type: "message", content: "child request", replyTo: "original-binding",
						},
					});
					if (output === undefined) return { type: "stop" };
					expect(output.isError).not.toBe(true);
					commissioned = true;
				}
				sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
				return { type: "stop" };
			},
		},
	});
	await app.gateway.ingest(
		{ kind: "external", surface: "ws", externalId: "owner" },
		{
			eventId: "initial", surface: "ws", channelId: "owner", addressees: [], dm: true,
			payload: {}, render: "start"
		},
	);
	await reply.promise;
	const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
	if (child?.parentId === null || child?.parentId === undefined) throw new Error("child parent missing");
	const rows = SessionHandleStore.inboxRows(child.parentId).filter((row) => {
		const value = row.origin.value;
		return value !== null && typeof value === "object" && !Array.isArray(value)
			&& value.kind === "child_terminal";
	});
	expect(rows).toHaveLength(1);
	expect(rows[0]?.origin.value).toMatchObject({
		kind: "child_terminal", childSessionId: child.id, replyTo: "original-binding",
	});
	expect(rows[0]?.content).toContain("CHILD_SENTINEL");
});
