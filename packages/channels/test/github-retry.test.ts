import { describe, expect, it } from "bun:test";
import { GitHubAdapter } from "../src/provider/github/surface";

const secret = "github-webhook-secret";
const deliveryId = "delivery-retry-1";
const body = JSON.stringify({
	action: "created",
	issue: {
		number: 7,
		title: "Run work",
		labels: [],
		user: { login: "octocat", type: "User" },
	},
	comment: {
		id: 1,
		body: "run",
		user: { login: "octocat", type: "User" },
	},
	repository: {
		full_name: "openomni/project",
		owner: { login: "openomni" },
		name: "project",
	},
});

const config = {};

describe("GitHubAdapter retryable delivery failures", () => {
	it("returns 5xx when the message handler throws", async () => {
		const adapter = new GitHubAdapter(secret, config, () => undefined);
		adapter.onMessage(async () => {
			throw new Error("handler unavailable");
		});

		const response = await adapter.handleWebhook(await webhookRequest(deliveryId));

		expect(response.status).toBeGreaterThanOrEqual(500);
	});

});

async function webhookRequest(id: string): Promise<Request> {
	return new Request("http://localhost/github/webhook", {
		method: "POST",
		headers: {
			"x-hub-signature-256": await signGitHubBody(body),
			"x-github-event": "issue_comment",
			"x-github-delivery": id,
		},
		body,
	});
}

async function signGitHubBody(value: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
	return `sha256=${Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}
