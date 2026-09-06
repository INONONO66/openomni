import { describe, expect, it } from "bun:test";
import type { ChannelAuthnDecisionObserver } from "../src/authn/types";
import { GitHubAdapter } from "../src/provider/github/surface";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];

const secret = "github-webhook-secret";
const config = {};

describe("GitHubAdapter channel-authn", () => {
	it("accepts valid HMAC signatures through channel-authn middleware", async () => {
		const decisions: ChannelAuthnDecision[] = [];
		const body = JSON.stringify({ action: "ignored" });
		const adapter = createAdapter(decisions);
		const request = new Request("http://localhost/github/webhook", {
			method: "POST",
			headers: {
				"x-hub-signature-256": await signGitHubBody(body),
				"x-github-event": "unknown",
			},
			body,
		});

		const response = await adapter.handleWebhook(request);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Unsupported event");
		expect(decisions).toEqual([
			expect.objectContaining({
				name: "channel-authn:github-hmac",
				policyId: "guardrail.permission",
				verdict: "allow",
				reason: "github signature verified",
			}),
		]);
	});

	it("rejects invalid HMAC signatures through channel-authn middleware", async () => {
		const decisions: ChannelAuthnDecision[] = [];
		const adapter = createAdapter(decisions);
		const request = new Request("http://localhost/github/webhook", {
			method: "POST",
			headers: { "x-hub-signature-256": "sha256=invalid" },
			body: JSON.stringify({ action: "ignored" }),
		});

		const response = await adapter.handleWebhook(request);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Invalid signature");
		expect(decisions).toEqual([
			expect.objectContaining({
				name: "channel-authn:github-hmac",
				policyId: "guardrail.permission",
				verdict: "deny",
				reason: "github signature invalid",
			}),
		]);
	});

	it("rejects missing HMAC signatures through channel-authn middleware", async () => {
		const decisions: ChannelAuthnDecision[] = [];
		const adapter = createAdapter(decisions);
		const request = new Request("http://localhost/github/webhook", {
			method: "POST",
			body: JSON.stringify({ action: "ignored" }),
		});

		const response = await adapter.handleWebhook(request);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Missing signature");
		expect(decisions).toEqual([
			expect.objectContaining({
				name: "channel-authn:github-hmac",
				policyId: "guardrail.permission",
				verdict: "deny",
				reason: "github signature missing",
			}),
		]);
	});

});

function createAdapter(
	decisions: ChannelAuthnDecision[],
	adapterConfig: Record<string, never> = config,
): GitHubAdapter {
	const adapter = new GitHubAdapter(secret, adapterConfig, () => undefined, undefined, undefined, {
		onDecision: (decision) => {
			decisions.push(decision);
		},
	});
	adapter.onMessage(async () => undefined);
	return adapter;
}

async function signGitHubBody(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return `sha256=${Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}
