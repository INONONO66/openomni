import { createHash } from "node:crypto";

export const CC_VERSION = "2.1.97";
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const TOOL_PREFIX = "mcp_";
export const REQUIRED_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
] as const;
export const USER_AGENT = `claude-cli/${CC_VERSION} (external, cli)`;
export const BILLING_HASH_SALT = "59cf53e54c78";
export const BILLING_HASH_INDICES = [4, 7, 20] as const;
export const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [];
export const TEXT_REPLACEMENTS: readonly { match: string; replacement: string }[] = [];
export const OPENOMNI_IDENTITY_PATTERNS: readonly string[] = [];
export const INSTANCE_SESSION_ID = crypto.randomUUID();

export type FetchInput = string | URL | Request;
export type SystemBlock = { type: string; text: string; [k: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }
  const initHeaders = init?.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => headers.set(key, value));
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string];
        if (typeof value !== "undefined") headers.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== "undefined") headers.set(key, String(value));
      }
    }
  }
  return headers;
}

export function mergeBetaHeaders(headers: Headers): string {
  const incoming = headers.get("anthropic-beta") || "";
  const incomingList = incoming
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return [...new Set([...REQUIRED_BETAS, ...incomingList])].join(",");
}

export function buildClaudeCodeHeaders(accessToken: string): Record<string, string> {
  const p = process.platform;
  const osName = p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : p;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return {
    authorization: `Bearer ${accessToken}`,
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": INSTANCE_SESSION_ID,
    "x-stainless-arch": arch,
    "x-stainless-lang": "js",
    "x-stainless-os": osName,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "anthropic-beta": mergeBetaHeaders(new Headers()),
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export function computeBillingFingerprint(firstUserText: string): string {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserText[i] ?? "0").join("");
  const input = `${BILLING_HASH_SALT}${chars}${CC_VERSION}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

export function buildBillingBlock(messages: unknown[]): SystemBlock {
  const firstUser = (messages ?? []).find(
    (message): message is { role: string; content: unknown } =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: string }).role === "user",
  );

  let firstText = "";
  if (firstUser) {
    if (typeof firstUser.content === "string") {
      firstText = firstUser.content;
    } else if (Array.isArray(firstUser.content)) {
      const textBlock = firstUser.content.find(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text",
      );
      firstText = textBlock?.text ?? "";
    }
  }

  const fingerprint = computeBillingFingerprint(firstText);
  return {
    type: "text",
    text: `x-anthropic-billing-header: cc_version=${CC_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=00000;`,
  };
}

export function sanitizeSystemText(text: string): string {
  if (!text) return text;

  // Fast path: if no identity patterns match, nothing to sanitize
  const hasIdentity = OPENOMNI_IDENTITY_PATTERNS.some((p) => text.includes(p));
  if (!hasIdentity && PARAGRAPH_REMOVAL_ANCHORS.length === 0 && TEXT_REPLACEMENTS.length === 0) {
    return text;
  }

  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    if (OPENOMNI_IDENTITY_PATTERNS.some((p) => paragraph.includes(p))) {
      // Drop paragraph if it IS exactly one of the identity patterns
      const isOnlyIdentity = OPENOMNI_IDENTITY_PATTERNS.some((p) => paragraph.trim() === p);
      if (isOnlyIdentity) return false;
    }
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }
    return true;
  });

  let result = filtered.join("\n\n");

  // Remove identity lines that were part of larger paragraphs
  for (const pattern of OPENOMNI_IDENTITY_PATTERNS) {
    result = result.replace(pattern, "");
  }
  result = result.replace(/\n{3,}/g, "\n\n");

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.split(rule.match).join(rule.replacement);
  }

  return result.trim();
}

export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (system == null) return [identityBlock];

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (isRecord(system)) {
    const type = typeof system.type === "string" ? system.type : "text";
    const text = typeof system.text === "string" ? system.text : "";
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }];
  }

  if (!Array.isArray(system)) return [identityBlock];

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === "string") return { type: "text", text: sanitizeSystemText(item) };
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return { ...item, type: "text", text: sanitizeSystemText(item.text) };
    }
    return { type: "text", text: String(item) };
  });

  // Idempotency: don't double-prepend
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) return sanitized;

  return [identityBlock, ...sanitized];
}

export function prefixToolNames(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ name?: string; [k: string]: unknown }>;
      messages?: Array<{
        content?: Array<{ type: string; name?: string; [k: string]: unknown }>;
        [k: string]: unknown;
      }>;
      [k: string]: unknown;
    };

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name:
          tool.name && !tool.name.startsWith(TOOL_PREFIX)
            ? `${TOOL_PREFIX}${tool.name}`
            : tool.name,
      }));
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map(
        (msg: {
          content?: Array<{ type: string; name?: string; [k: string]: unknown }>;
          [k: string]: unknown;
        }) => {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map(
              (block: { type: string; name?: string; [k: string]: unknown }) => {
                if (
                  block.type === "tool_use" &&
                  block.name &&
                  !block.name.startsWith(TOOL_PREFIX)
                ) {
                  return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                }
                return block;
              },
            );
          }
          return msg;
        },
      );
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const baseUrl = new URL(raw);
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null;
    }
    return baseUrl;
  } catch {
    return null;
  }
}

export function rewriteUrl(input: FetchInput): { input: FetchInput; url: URL | null } {
  let requestUrl: URL | null = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }

  if (!requestUrl) return { input, url: null };

  const originalHref = requestUrl.href;
  const baseUrl = resolveBaseUrl();
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol;
    requestUrl.host = baseUrl.host;
  }

  if (requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
  }

  if (requestUrl.href === originalHref) return { input, url: requestUrl };

  const newInput =
    input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  return { input: newInput, url: requestUrl };
}

export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      system?: unknown;
      messages?: Array<{ role: string; content: unknown }>;
      tools?: Array<{ name?: string; description?: string; [k: string]: unknown }>;
    };

    const billingBlock = buildBillingBlock(parsed.messages ?? []);
    const withIdentity = prependClaudeCodeIdentity(parsed.system);

    parsed.system = [billingBlock, ...withIdentity];

    if (Array.isArray(parsed.system) && parsed.system.length > 2) {
      const kept = [parsed.system[0], parsed.system[1]];
      const movedTexts: string[] = [];

      for (let i = 2; i < parsed.system.length; i++) {
        const entry = parsed.system[i];
        const txt =
          typeof entry === "string"
            ? entry
            : typeof (entry as { text?: unknown }).text === "string"
              ? (entry as { text: string }).text
              : "";
        if (txt.length > 0) movedTexts.push(txt);
      }

      if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
        const firstUser = parsed.messages.find((message) => message.role === "user");
        if (firstUser) {
          parsed.system = kept;
          const prefix = movedTexts.join("\n\n");
          if (typeof firstUser.content === "string") {
            firstUser.content = `${prefix}\n\n${firstUser.content}`;
          } else if (Array.isArray(firstUser.content)) {
            firstUser.content.unshift({ type: "text", text: prefix });
          }
        }
      }
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => {
        const name =
          tool.name && !tool.name.startsWith(TOOL_PREFIX)
            ? `${TOOL_PREFIX}${tool.name}`
            : tool.name;
        return { ...tool, name, description: "" };
      });
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map(
              (block: { type?: string; name?: string; [k: string]: unknown }) => {
                if (
                  block.type === "tool_use" &&
                  block.name &&
                  !block.name.startsWith(TOOL_PREFIX)
                ) {
                  return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                }
                return block;
              },
            ),
          };
        }
        return msg;
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export function createStrippedStream(response: Response): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let tailBuffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        const remaining = tailBuffer + decoder.decode();
        if (remaining) {
          controller.enqueue(encoder.encode(stripToolPrefix(remaining)));
        }
        controller.close();
        return;
      }

      const chunk = tailBuffer + decoder.decode(value, { stream: true });
      const lastNameIdx = chunk.lastIndexOf('"name"');

      let flushable: string;
      if (lastNameIdx === -1) {
        const safeLen = Math.max(0, chunk.length - 64);
        flushable = chunk.slice(0, safeLen);
        tailBuffer = chunk.slice(safeLen);
      } else {
        flushable = chunk.slice(0, lastNameIdx);
        tailBuffer = chunk.slice(lastNameIdx);
      }

      if (flushable) {
        controller.enqueue(encoder.encode(stripToolPrefix(flushable)));
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false;
  const raw = process.env.ANTHROPIC_INSECURE?.trim();
  return raw === "1" || raw === "true";
}
