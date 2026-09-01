import { afterEach, describe, expect, test } from "bun:test";
import { arch, platform, release } from "node:os";
import type { Auth } from "../../src/auth";
import { clientIdentity } from "../../src/provider/identity";
import type { Provider } from "../../src/provider";
import { getSDK } from "../../src/provider/sdk";

/** `pi/<version> (<platform> <kernelRelease>; <arch>)` — the whole contract. */
const IDENTITY_PATTERN = /^pi\/\d+\.\d+\.\d+ \(.+; .+\)$/;

const originalFetch = globalThis.fetch;

function anthropicModel(): Provider.Model {
  return {
    id: "claude-3-haiku",
    providerID: "anthropic",
    name: "Claude 3 Haiku",
    api: { npm: "@ai-sdk/anthropic" },
  };
}

/**
 * The header is asserted where it actually matters — on the request the SDK
 * puts on the wire — rather than on the options object handed to the factory:
 * a default that the SDK drops on the floor would still pass the latter.
 */
async function capturedRequestHeaders(auth: Auth.Info): Promise<Headers> {
  let captured: Headers | undefined;
  globalThis.fetch = (async (_input: unknown, init: { headers?: Record<string, string> }) => {
    captured = new Headers(init.headers);
    return new Response(
      JSON.stringify({
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-3-haiku",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const sdk = getSDK(anthropicModel(), auth);
  await sdk
    .languageModel("claude-3-haiku")
    .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

  if (captured === undefined) expect.unreachable("Expected the SDK to issue a request");
  return captured;
}

describe("clientIdentity", () => {
  test("renders pi/<version> (<platform> <kernelRelease>; <arch>)", () => {
    const identity = clientIdentity();

    expect(identity).toMatch(IDENTITY_PATTERN);
    expect(identity).toBe(
      `pi/${clientIdentity.version} (${platform()} ${release()}; ${arch()})`,
    );
  });

  test("is pure — repeated calls render the same string", () => {
    expect(clientIdentity()).toBe(clientIdentity());
  });

  test("reports the package manifest's version", async () => {
    const manifest = (await Bun.file(
      new URL("../../package.json", import.meta.url),
    ).json()) as { version: string };

    expect(clientIdentity.version).toBe(manifest.version);
  });
});

describe("provider SDK client identity header", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends the pi client identity as the default user-agent", async () => {
    const headers = await capturedRequestHeaders({ type: "api", key: "sk-identity-default" });

    const userAgent = headers.get("user-agent") ?? "";
    // The AI SDK appends its own runtime segments after whatever default the
    // caller set, so the identity is the prefix, not the whole value.
    const [ours] = userAgent.split(" ai-sdk/");
    expect(ours).toMatch(IDENTITY_PATTERN);
    expect(ours).toBe(clientIdentity());
  });

  test("keeps the provider's own default headers alongside the identity", async () => {
    const headers = await capturedRequestHeaders({ type: "api", key: "sk-identity-beta" });

    expect(headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    );
  });
});
