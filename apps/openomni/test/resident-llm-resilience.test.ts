import { providerFailure } from "./helpers/provider-failure";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Auth } from "@openomni/llm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import type { Model } from "@openomni/protocol";
import { createResidentGateway } from "../src/gateway";
import { wakeSession } from "@openomni/agent";
import { commitMessageInbox, prepareMessage } from "../src/composition/message-session";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
	mock.restore();
	Storage.reset();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const PRIMARY: Model.Ref = { provider: "fake", id: "resident-test" };
const FALLBACK: Model.Ref = { provider: "other", id: "fallback-model" };

function openSession(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	initialize({ dbPath: join(directory, "chat.db") });
	// Delivery, not fixture CRUD, owns real handle materialization.
	return crypto.randomUUID();
}

describe("Resident model fallback wiring", () => {
	it("resolves the configured fallback on the retry after a transient failure", async () => {
		const sessionId = openSession("openomni-resident-fallback-");
		const resolved: Model.Ref[] = [];
		const auths: Auth.Info[] = [];
		const credentials = spyOn(Auth, "get").mockResolvedValue({ type: "api", key: "fallback-key" });
		let calls = 0;

		const resident = createResident({
			model: PRIMARY,
			modelFallbacks: [FALLBACK],
			apiKey: "test-key",
			tools: {},
			targets: () => [],
			llm: {
				resolveModel: async (model) => {
					resolved.push(model);
					return { id: model.id, name: model.id, providerID: model.provider };
				},
				run: async (input, sink) => {
					auths.push(await Auth.resolve(input.model.providerID, input.auth, input.authProvider));
					calls += 1;
					if (calls === 1) {
						return { type: "error", error: providerFailure("transient blip") };
					}
					sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
					return { type: "stop" };
				},
			},
		});

		const result = await resident.prompt(sessionId, "please answer");

		expect(resolved).toEqual([PRIMARY, FALLBACK]);
		expect(auths).toEqual([
			{ type: "api", key: "test-key" },
			{ type: "api", key: "fallback-key" },
		]);
		expect(credentials.mock.calls).toEqual([[FALLBACK.provider]]);
		expect(result.kind).not.toBe("dropped");
	});

	it("keeps every attempt on the primary when no fallback is configured", async () => {
		const sessionId = openSession("openomni-resident-no-fallback-");
		const resolved: Model.Ref[] = [];
		let calls = 0;

		const resident = createResident({
			model: PRIMARY,
			apiKey: "test-key",
			tools: {},
			targets: () => [],
			llm: {
				resolveModel: async (model) => {
					resolved.push(model);
					return { id: model.id, name: model.id, providerID: model.provider };
				},
				run: async (input, sink) => {
					calls += 1;
					if (calls === 1) {
						return { type: "error", error: providerFailure("transient blip") };
					}
					sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
					return { type: "stop" };
				},
			},
		});

		await resident.prompt(sessionId, "please answer");

		expect(resolved).toEqual([PRIMARY, PRIMARY]);
	});
});

/**
 * An AI SDK provider error as the SDK actually raises it: the retry facts
 * live on the error object, not under `.data`. Building the fixture this way
 * (rather than importing the llm package's internal APIError) keeps the test
 * on the same shape production coercion has to survive.
 */
function providerError(fields: {
	readonly message: string;
	readonly isRetryable: boolean;
	readonly statusCode?: number;
	readonly responseBody?: string;
}): Error {
	return Object.assign(new Error(fields.message), {
		name: "AI_APICallError",
		isRetryable: fields.isRetryable,
		...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
		...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
	});
}

describe("Resident terminal LLM failure surfacing", () => {
	function alwaysFailing(error: Error) {
		return {
			resolveModel: async (model: Model.Ref) => ({
				id: model.id,
				name: model.id,
				providerID: model.provider,
			}),
			run: async () => ({ type: "error" as const, error: providerFailure(error.message, error) }),
		};
	}

	function residentThatAlwaysFails(error: Error) {
		return createResident({
			model: PRIMARY,
			apiKey: "test-key",
			tools: {},
			targets: () => [],
			llm: alwaysFailing(error),
		});
	}

	it("answers a rate-limited exhaustion with a classified, attempt-counted reply", async () => {
		const sessionId = openSession("openomni-resident-ratelimit-");
		const resident = residentThatAlwaysFails(
			providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
		);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.text).toContain("rate limited upstream");
		expect(result.text).toContain("tried 3 times");
		expect(result.kind).toBe("error");
	});

	it("names a spent balance for a billing exhaustion, unhedged", async () => {
		const sessionId = openSession("openomni-resident-billing-");
		const resident = residentThatAlwaysFails(
			providerError({
				message: JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }),
				isRetryable: true,
				statusCode: 429,
			}),
		);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.text).toContain("quota/billing exhausted");
		expect(result.text).toContain("check provider account");
		expect(result.text).not.toContain("may be exhausted");
	});

	it.each([
		{ message: "402 Payment Required", name: "a bare payment-required response" },
		{ message: "billing_error: card declined", name: "a declined-card billing error" },
	])("hedges $name as MAY be exhausted", async ({ message }) => {
		const sessionId = openSession("openomni-resident-billing-hedged-");
		const resident = residentThatAlwaysFails(
			providerError({ message, isRetryable: false, statusCode: 402 }),
		);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.text).toContain("may be exhausted");
	});

	it("names a content-policy refusal", async () => {
		const sessionId = openSession("openomni-resident-content-policy-");
		const resident = residentThatAlwaysFails(
			providerError({
				message: JSON.stringify({
					error: { type: "invalid_request_error", code: "content_policy_violation" },
				}),
				isRetryable: false,
				statusCode: 400,
			}),
		);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.text).toContain("content policy");
	});

	it("does not expose raw unknown-fault details", async () => {
		const sessionId = openSession("openomni-resident-unknown-");
		const resident = residentThatAlwaysFails(
			new Error("request failed apiKey=sk-live-SECRET baseURL=https://internal.example/v1"),
		);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.text).toContain("could not reach the model");
		expect(result.text).not.toContain("sk-live-SECRET");
		expect(result.text).not.toContain("https://internal.example/v1");
	});

	it("returns one sanitized reply through gateway ingestion", async () => {
		openSession("openomni-resident-gateway-");
		const resident = residentThatAlwaysFails(
			providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
		);
		const gateway = createResidentGateway({
			inbox: { commit: commitMessageInbox }, prepare: prepareMessage(resident.materialize),
		});

		const result = await gateway.ingest({ kind: "external", surface: "ws", externalId: "owner" }, {
			eventId: "inbound-resilience-gateway", surface: "ws", channelId: "owner", addressees: [], dm: true, payload: {}, render: "please answer",
		});
		if (result.status !== "executed") throw new Error("gateway did not commit");
		const completed = await wakeSession(result.handle.target, resident.runnerFor(SessionHandleStore.row(result.handle.target)), resident.runtime);
		expect(completed?.text).toContain("rate limited upstream");
		expect(SessionHandleStore.getSnapshot(result.handle.target).turns.at(-1)?.terminal?.kind).toBe(
			"error",
		);
	});

	it("does not convert a configuration failure into a model reply", async () => {
		const sessionId = openSession("openomni-resident-config-failure-");
		const resident = createResident({
			model: PRIMARY,
			apiKey: "test-key",
			tools: {},
			targets: () => [],
			llm: {
				resolveModel: async () => {
					throw new Error("catalog invariant failed");
				},
			},
		});

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") throw new Error("configuration fault was not an error");
		expect(result.cause?.message).toBe("catalog invariant failed");
	});

	it("records the classified reply in session history so the turn is auditable", async () => {
		const sessionId = openSession("openomni-resident-failure-history-");
		const resident = residentThatAlwaysFails(
			providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
		);

		await resident.prompt(sessionId, "please answer");

		const tail = SessionHandleStore.getSnapshot(sessionId).turns.at(-1);
		expect(tail?.terminal?.kind).toBe("error");
		expect(tail?.messages.at(-1)?.text).toContain("rate limited upstream");
	});

	it("lets an abort keep propagating — a stopped run is not a model fault", async () => {
		const sessionId = openSession("openomni-resident-abort-");
		const aborted = new Error("aborted");
		aborted.name = "AbortError";
		const resident = residentThatAlwaysFails(aborted);

		const result = await resident.prompt(sessionId, "please answer");
		expect(result.kind).toBe("interrupted");
	});
});
