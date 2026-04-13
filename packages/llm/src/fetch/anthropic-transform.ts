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

export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  void input;
  void init;
  throw new Error("not implemented");
}

export function mergeBetaHeaders(headers: Headers): string {
  void headers;
  throw new Error("not implemented");
}

export function buildClaudeCodeHeaders(accessToken: string): Record<string, string> {
  void accessToken;
  throw new Error("not implemented");
}

export function computeBillingFingerprint(firstUserText: string): string {
  void firstUserText;
  throw new Error("not implemented");
}

export function buildBillingBlock(messages: unknown[]): SystemBlock {
  void messages;
  throw new Error("not implemented");
}

export function sanitizeSystemText(text: string): string {
  void text;
  throw new Error("not implemented");
}

export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  void system;
  throw new Error("not implemented");
}

export function prefixToolNames(body: string): string {
  void body;
  throw new Error("not implemented");
}

export function stripToolPrefix(text: string): string {
  void text;
  throw new Error("not implemented");
}

export function rewriteUrl(input: FetchInput): { input: FetchInput; url: URL | null } {
  void input;
  throw new Error("not implemented");
}

export function rewriteRequestBody(body: string): string {
  void body;
  throw new Error("not implemented");
}

export function createStrippedStream(response: Response): Response {
  void response;
  throw new Error("not implemented");
}

export function isInsecure(): boolean {
  throw new Error("not implemented");
}
