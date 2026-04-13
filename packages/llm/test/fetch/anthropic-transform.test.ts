import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mergeHeaders,
  mergeBetaHeaders,
  buildClaudeCodeHeaders,
  computeBillingFingerprint,
  buildBillingBlock,
  sanitizeSystemText,
  prependClaudeCodeIdentity,
  prefixToolNames,
  stripToolPrefix,
  rewriteUrl,
  rewriteRequestBody,
  createStrippedStream,
  isInsecure,
  CC_VERSION,
  CLAUDE_CODE_IDENTITY,
  REQUIRED_BETAS,
} from "../../src/fetch/anthropic-transform";

async function streamToText(response: Response): Promise<string> {
  return response.text();
}

function makeStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  (async () => {
    for (const chunk of chunks) {
      await writer.write(encoder.encode(chunk));
    }
    await writer.close();
  })();
  return new Response(readable);
}

function saveEnv(...keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

describe("mergeHeaders", () => {
  test("extracts headers from Request", () => {
    const req = new Request("https://api.example.com", {
      headers: { "x-from-req": "yes" },
    });
    expect(mergeHeaders(req).get("x-from-req")).toBe("yes");
  });

  test("merges Headers instance from init", () => {
    const h = mergeHeaders("https://a.com", {
      headers: new Headers({ "x-h": "val" }),
    });
    expect(h.get("x-h")).toBe("val");
  });

  test("merges array entries from init", () => {
    const h = mergeHeaders("https://a.com", {
      headers: [["x-arr", "v"]],
    });
    expect(h.get("x-arr")).toBe("v");
  });

  test("merges record from init", () => {
    const h = mergeHeaders("https://a.com", { headers: { "x-rec": "v" } });
    expect(h.get("x-rec")).toBe("v");
  });

  test("init overrides Request on conflict", () => {
    const req = new Request("https://a.com", { headers: { "x-k": "old" } });
    const h = mergeHeaders(req, { headers: { "x-k": "new" } });
    expect(h.get("x-k")).toBe("new");
  });
});

describe("mergeBetaHeaders", () => {
  test("includes all 5 REQUIRED_BETAS when empty", () => {
    const betas = mergeBetaHeaders(new Headers()).split(",");
    expect(betas).toHaveLength(5);
    for (const b of REQUIRED_BETAS) expect(betas).toContain(b);
  });

  test("preserves user-supplied betas", () => {
    const h = new Headers({ "anthropic-beta": "custom-beta-1" });
    const betas = mergeBetaHeaders(h).split(",");
    expect(betas).toContain("custom-beta-1");
    expect(betas).toHaveLength(6);
  });

  test("deduplicates already-present required beta", () => {
    const h = new Headers({ "anthropic-beta": REQUIRED_BETAS[0] });
    const betas = mergeBetaHeaders(h).split(",");
    expect(betas.filter((b) => b === REQUIRED_BETAS[0])).toHaveLength(1);
    expect(betas).toHaveLength(5);
  });
});

describe("buildClaudeCodeHeaders", () => {
  test("includes all expected header keys", () => {
    const h = buildClaudeCodeHeaders("tok");
    const keys = [
      "authorization",
      "user-agent",
      "x-app",
      "x-claude-code-session-id",
      "x-stainless-arch",
      "x-stainless-lang",
      "x-stainless-os",
      "x-stainless-package-version",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-retry-count",
      "x-stainless-timeout",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access",
    ];
    for (const k of keys) expect(h).toHaveProperty(k);
  });

  test("user-agent contains CC_VERSION", () => {
    expect(buildClaudeCodeHeaders("t")["user-agent"]).toContain(CC_VERSION);
  });

  test("session ID is a valid UUID", () => {
    const sid = buildClaudeCodeHeaders("t")["x-claude-code-session-id"];
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("authorization uses Bearer scheme", () => {
    expect(buildClaudeCodeHeaders("abc").authorization).toBe("Bearer abc");
  });
});

describe("computeBillingFingerprint", () => {
  test("returns 3-character hex string", () => {
    const fp = computeBillingFingerprint("hello world");
    expect(fp).toHaveLength(3);
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
  });

  test("deterministic for same input", () => {
    expect(computeBillingFingerprint("x")).toBe(computeBillingFingerprint("x"));
  });

  test("handles short text with out-of-bounds indices", () => {
    const fp = computeBillingFingerprint("ab");
    expect(fp).toHaveLength(3);
    expect(fp).toMatch(/^[0-9a-f]{3}$/);
  });
});

describe("buildBillingBlock", () => {
  test("produces correct billing header format", () => {
    const block = buildBillingBlock([{ role: "user", content: "hi" }]);
    expect(block.type).toBe("text");
    expect(block.text).toMatch(
      /^x-anthropic-billing-header: cc_version=[\d.]+\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/,
    );
    expect(block.text).toContain(CC_VERSION);
  });

  test("extracts text from array content blocks", () => {
    const block = buildBillingBlock([
      { role: "user", content: [{ type: "text", text: "array text" }] },
    ]);
    expect(block.type).toBe("text");
    expect(block.text).toContain("cc_version=");
  });

  test("handles empty messages", () => {
    const block = buildBillingBlock([]);
    expect(block.type).toBe("text");
    expect(block.text).toContain("cc_version=");
  });
});

describe("sanitizeSystemText", () => {
  test("returns empty string unchanged", () => {
    expect(sanitizeSystemText("")).toBe("");
  });

  test("no-op when all config arrays are empty", () => {
    const text = "You are a helpful assistant.\n\nPlease follow instructions.";
    expect(sanitizeSystemText(text)).toBe(text);
  });
});

describe("prependClaudeCodeIdentity", () => {
  test("null → [identity]", () => {
    const r = prependClaudeCodeIdentity(null);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
  });

  test("undefined → [identity]", () => {
    const r = prependClaudeCodeIdentity(undefined);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
  });

  test("string → [identity, {text: string}]", () => {
    const r = prependClaudeCodeIdentity("Custom prompt");
    expect(r).toHaveLength(2);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(r[1]).toEqual({ type: "text", text: "Custom prompt" });
  });

  test("record → [identity, record with preserved fields]", () => {
    const input = { type: "text", text: "from record", cache_control: { type: "ephemeral" } };
    const r = prependClaudeCodeIdentity(input);
    expect(r).toHaveLength(2);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(r[1].text).toBe("from record");
    expect(r[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("array → [identity, ...items]", () => {
    const r = prependClaudeCodeIdentity([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
    ]);
    expect(r).toHaveLength(3);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(r[1].text).toBe("A");
    expect(r[2].text).toBe("B");
  });

  test("idempotent: identity already first → no duplication", () => {
    const r = prependClaudeCodeIdentity([
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: "extra" },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
  });

  test("string matching identity → single block", () => {
    const r = prependClaudeCodeIdentity(CLAUDE_CODE_IDENTITY);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe(CLAUDE_CODE_IDENTITY);
  });
});

describe("prefixToolNames", () => {
  test("prefixes tool names in tools array", () => {
    const body = JSON.stringify({ tools: [{ name: "read_file" }] });
    expect(JSON.parse(prefixToolNames(body)).tools[0].name).toBe("mcp_read_file");
  });

  test("prefixes tool_use names in messages", () => {
    const body = JSON.stringify({
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "write", id: "t1" }] }],
    });
    expect(JSON.parse(prefixToolNames(body)).messages[0].content[0].name).toBe("mcp_write");
  });

  test("does not double-prefix", () => {
    const body = JSON.stringify({ tools: [{ name: "mcp_x" }] });
    expect(JSON.parse(prefixToolNames(body)).tools[0].name).toBe("mcp_x");
  });

  test("returns body unchanged for invalid JSON", () => {
    expect(prefixToolNames("{broken")).toBe("{broken");
  });

  test("leaves non-tool_use blocks untouched", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const result = JSON.parse(prefixToolNames(body));
    expect(result.messages[0].content[0]).toEqual({ type: "text", text: "hi" });
  });
});

describe("stripToolPrefix", () => {
  test("strips mcp_ from name key values", () => {
    expect(stripToolPrefix('"name":"mcp_foo"')).toBe('"name": "foo"');
  });

  test("preserves mcp_ in non-name contexts", () => {
    expect(stripToolPrefix('"text":"mcp_foo"')).toBe('"text":"mcp_foo"');
  });

  test("handles multiple name entries", () => {
    const r = stripToolPrefix('"name":"mcp_a" and "name":"mcp_b"');
    expect(r).toContain('"name": "a"');
    expect(r).toContain('"name": "b"');
  });
});

describe("rewriteUrl", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv("ANTHROPIC_BASE_URL");
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => restoreEnv(saved));

  test("/v1/messages gets ?beta=true", () => {
    const { url } = rewriteUrl("https://api.anthropic.com/v1/messages");
    expect(url?.searchParams.get("beta")).toBe("true");
  });

  test("non-messages path unchanged", () => {
    const { url } = rewriteUrl("https://api.anthropic.com/v1/complete");
    expect(url?.searchParams.has("beta")).toBe(false);
  });

  test("ANTHROPIC_BASE_URL overrides host", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    const { url } = rewriteUrl("https://api.anthropic.com/v1/messages");
    expect(url?.host).toBe("proxy.example.com");
    expect(url?.searchParams.get("beta")).toBe("true");
  });

  test("supports Request input", () => {
    const { url } = rewriteUrl(new Request("https://api.anthropic.com/v1/messages"));
    expect(url?.searchParams.get("beta")).toBe("true");
  });

  test("supports URL input", () => {
    const { url } = rewriteUrl(new URL("https://api.anthropic.com/v1/messages"));
    expect(url?.searchParams.get("beta")).toBe("true");
  });
});

describe("isInsecure", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv("ANTHROPIC_BASE_URL", "ANTHROPIC_INSECURE");
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_INSECURE;
  });

  afterEach(() => restoreEnv(saved));

  test("false when no env vars set", () => {
    expect(isInsecure()).toBe(false);
  });

  test("false when only ANTHROPIC_BASE_URL set", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
    expect(isInsecure()).toBe(false);
  });

  test('true when both set and INSECURE="1"', () => {
    process.env.ANTHROPIC_BASE_URL = "http://local.dev";
    process.env.ANTHROPIC_INSECURE = "1";
    expect(isInsecure()).toBe(true);
  });

  test('true when both set and INSECURE="true"', () => {
    process.env.ANTHROPIC_BASE_URL = "http://local.dev";
    process.env.ANTHROPIC_INSECURE = "true";
    expect(isInsecure()).toBe(true);
  });
});

describe("rewriteRequestBody — v1.4 relocation", () => {
  test("null system → [billing, identity], user unchanged", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system).toHaveLength(2);
    expect(result.system[0].text).toMatch(/x-anthropic-billing-header/);
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(result.messages[0].content).toBe("hello");
  });

  test("string system → relocated to first user message", () => {
    const body = JSON.stringify({
      system: "Custom prompt",
      messages: [{ role: "user", content: "hello" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system).toHaveLength(2);
    expect(result.messages[0].content).toBe("Custom prompt\n\nhello");
  });

  test("array system with extras → extras relocated", () => {
    const body = JSON.stringify({
      system: [
        { type: "text", text: "extra A" },
        { type: "text", text: "extra B" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system).toHaveLength(2);
    expect(result.messages[0].content).toContain("extra A");
    expect(result.messages[0].content).toContain("extra B");
  });

  test("array system with only identity → no relocation", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
      messages: [{ role: "user", content: "hello" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system).toHaveLength(2);
    expect(result.messages[0].content).toBe("hello");
  });

  test("no user message → system keeps extras (relocation skipped)", () => {
    const body = JSON.stringify({
      system: "Custom prompt",
      messages: [{ role: "assistant", content: "response" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system.length).toBeGreaterThan(2);
  });

  test("array user content → text block unshifted", () => {
    const body = JSON.stringify({
      system: "Moved instructions",
      messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.system).toHaveLength(2);
    expect(result.messages[0].content[0]).toEqual({
      type: "text",
      text: "Moved instructions",
    });
    expect(result.messages[0].content[1].text).toBe("original");
  });

  test("multiple user messages → only first gets prefix", () => {
    const body = JSON.stringify({
      system: "Prefix text",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.messages[0].content).toContain("Prefix text");
    expect(result.messages[1].content).toBe("second");
  });

  test("tools prefixed and descriptions stripped", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "read_file", description: "Read a file from disk" }],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.tools[0].name).toBe("mcp_read_file");
    expect(result.tools[0].description).toBe("");
  });

  test("tool_use blocks in messages prefixed", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "write_file", id: "t1" }],
        },
      ],
    });
    const result = JSON.parse(rewriteRequestBody(body));
    expect(result.messages[1].content[0].name).toBe("mcp_write_file");
  });

  test("invalid JSON → body unchanged", () => {
    expect(rewriteRequestBody("not json")).toBe("not json");
  });
});

describe("createStrippedStream", () => {
  test("single chunk: strips mcp_ prefix", async () => {
    const response = makeStream(['{"name":"mcp_foo","x":1}']);
    const result = await streamToText(createStrippedStream(response));
    expect(result).toContain('"name": "foo"');
    expect(result).not.toContain("mcp_foo");
  });

  test("chunk boundary: split mid-pattern reassembled", async () => {
    // Padding ensures every pull() enqueues (works around Bun stream backpressure)
    const pad = "a".repeat(100);
    const response = makeStream([`${pad}"name":"mcp`, '_foo","name":"mcp_bar"}']);
    const result = await streamToText(createStrippedStream(response));
    expect(result).toContain('"name": "foo"');
    expect(result).toContain('"name": "bar"');
    expect(result).not.toContain("mcp_foo");
    expect(result).not.toContain("mcp_bar");
  });

  test("null body → returns original response", () => {
    const response = new Response(null);
    const result = createStrippedStream(response);
    expect(result.body).toBeNull();
  });

  test("multi-byte UTF-8 preserved", async () => {
    const response = makeStream(['{"name":"mcp_test","msg":"こんにちは"}']);
    const result = await streamToText(createStrippedStream(response));
    expect(result).toContain("こんにちは");
    expect(result).toContain('"name": "test"');
  });

  test("final flush: tail buffer stripped on close", async () => {
    const pad = "b".repeat(100);
    const response = makeStream([pad, '"name":"mcp_end"']);
    const result = await streamToText(createStrippedStream(response));
    expect(result).toContain('"name": "end"');
    expect(result).not.toContain("mcp_end");
  });
});
